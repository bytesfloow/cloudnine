#!/usr/bin/env python3
"""CloudNine 部署编排器（从开发机执行，驱动远端服务器完成部署）

职责：
  1. 可选：把本地已提交的改动推送到 GitHub
  2. SSH 到目标服务器，拉取代码 → 安装依赖 → 构建 → 重启 → 健康检查
  3. 首次部署时自动走 bootstrap.sh（装 Node/nginx、建账号、配 systemd）
  4. 部署完成后在服务器本机跑一遍 API 冒烟测试（传入实际 FILE_ROOT，含软链用例）

用法：
  # 首次部署
  python3 scripts/deploy_cloudnine.py --host 1.2.3.4 --user ubuntu --bootstrap

  # 常规部署
  python3 scripts/deploy_cloudnine.py --host 1.2.3.4 --user ubuntu

  # 本地有未推送提交时，先推再部署
  python3 scripts/deploy_cloudnine.py --host 1.2.3.4 --user ubuntu --push

  # 凭据与目标都已写进 .secrets/*.env 时，可以零参数直接部署
  python3 scripts/deploy_cloudnine.py --push

连接方式：
  --key <path>   SSH 私钥路径（推荐；默认 ~/.ssh/id_ed25519）
  --password     密码登录（需要系统已安装 sshpass）
  环境变量 SSH_PASSWORD 可替代 --password

  凭据文件：.secrets/*.env（已被 .gitignore 忽略，仅本机保留）自动载入，
  支持 SSH_PASSWORD / CN_SSH_PASS / CN_DEPLOY_HOST / CN_DEPLOY_USER，
  例如 .secrets/aliyun.env 里写 export SSH_PASSWORD='...'

 安全：密码经 SSHPASS 环境变量由 `sshpass -e` 读取，只注入本次 ssh 子进程，
       不进入命令行参数（ps 可见）、不回显到日志（run() 会打印完整命令）。
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SECRETS_DIR = REPO_ROOT / ".secrets"
# 服务端部署目录（与 scripts/deploy_remote.sh 的 DEPLOY_DIR 保持同默认值，可用环境变量覆盖）
DEPLOY_DIR = os.environ.get("CN_DEPLOY_DIR", "/opt/cloudnine")
# 服务端运行参数文件（systemd 的 EnvironmentFile，也是 FILE_ROOT / TRUST_PROXY 的唯一来源）
ENV_FILE = "/etc/cloudnine/cloudnine.env"

GREEN, RED, YELLOW, CYAN, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[2m", "\033[1m", "\033[0m",
)


def _stdio_safe() -> None:
    """让脚本自己的输出在中文 Windows 控制台（cp936）上也活得下来。

    cp936 里没有 ✓ / ✗ / ⚠，直接 print 会抛 UnicodeEncodeError（哪怕远端输出
    已经正确解码）。把错误降级成替换字符，并在下方 _mark() 里换成 ASCII 说法，
    这样不需要调用方设 PYTHONUTF8 / chcp 65001 也能跑完部署。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass


def _mark(unicode_mark: str, ascii_mark: str) -> str:
    """控制台代码页能不能表示这个符号，不能就用 ASCII 替身。"""
    enc = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        unicode_mark.encode(enc)
    except (UnicodeEncodeError, LookupError):
        return ascii_mark
    return unicode_mark


MARK_OK = _mark("✓", "OK")
MARK_ERR = _mark("✗", "x")
MARK_WARN = _mark("⚠", "!")


_stdio_safe()


def load_secrets() -> list[str]:
    """从 .secrets/*.env 载入部署凭据（SSH_PASSWORD / CN_DEPLOY_HOST 等）。

    .secrets/ 已被 .gitignore 忽略，只在本机留一份；已存在的环境变量优先，
    不覆盖命令行显式传入的值。文件缺失时静默跳过 —— 此时仍可用密钥或交互输入。
    """
    loaded: list[str] = []
    if not SECRETS_DIR.is_dir():
        return loaded
    for path in sorted(SECRETS_DIR.glob("*.env")):
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for raw in content.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key.startswith("export "):   # 兼容 `export KEY=value` 写法
                key = key[len("export "):].strip()
            value = value.strip().strip("'\"")
            if key and value and key not in os.environ:
                os.environ[key] = value
                loaded.append(key)
    return loaded


def info(msg: str) -> None:
    print(f"{CYAN}==>{RESET} {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"{GREEN}  {MARK_OK}{RESET} {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"{YELLOW}  {MARK_WARN}{RESET} {msg}", flush=True)


def err(msg: str) -> None:
    print(f"{RED}  {MARK_ERR}{RESET} {msg}", flush=True)


def run(cmd: list[str], *, cwd: Path | None = None, check: bool = True,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    info(" $ " + " ".join(shlex.quote(c) for c in cmd))
    # 显式指定 utf-8：远端（Linux/中文/emoji）输出是 UTF-8，而中文 Windows 的
    # subprocess 默认用系统 ANSI 代码页（GBK）解码，一遇中文/emoji 就抛
    # UnicodeDecodeError 并把 proc.stdout 留成 None（后续 .strip() 就 AttributeError）。
    # errors="replace" 保证即使混入非 UTF-8 字节也不会中断部署，只留一个替换字符。
    proc = subprocess.run(
        cmd, cwd=cwd, env=env, text=True, capture_output=True,
        encoding="utf-8", errors="replace",
    )
    # 判空：任何解码/管道异常都不能让下游 .strip() 崩在 NoneType 上
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    if stdout.strip():
        print(stdout.rstrip())
    if stderr.strip():
        print(stderr.rstrip(), file=sys.stderr)
    if check and proc.returncode != 0:
        err(f"命令失败（退出码 {proc.returncode}）")
        raise SystemExit(1)
    return proc


def ssh_cmd(args: argparse.Namespace, remote_cmd: str) -> tuple[list[str], dict[str, str]]:
    """构造 ssh 命令，以及只注入给该 ssh 子进程的额外环境变量。

    密码模式用 `sshpass -e` 从 SSHPASS 读取密码：密码既不出现在命令行参数
    （会被 ps 看到、被 run() 回显到日志），也不写进全局 os.environ
    （会被 git push / 冒烟测试等所有子进程继承）。
    """
    base = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"]
    if args.port:
        base += ["-p", str(args.port)]
    if args.key:
        base += ["-i", str(args.key)]
    target = f"{args.user}@{args.host}"

    password = args.password or os.environ.get("SSH_PASSWORD")
    if password and not args.key:
        if not shutil_which("sshpass"):
            err("需要密码登录但系统未安装 sshpass（apt-get install -y sshpass）")
            raise SystemExit(1)
        return ["sshpass", "-e"] + base + [target, remote_cmd], {"SSHPASS": password}
    return base + [target, remote_cmd], {}


def shutil_which(name: str) -> str | None:
    import shutil

    return shutil.which(name)


def remote_run(args: argparse.Namespace, remote_cmd: str, *, as_root: bool = False) -> subprocess.CompletedProcess:
    if as_root:
        remote_cmd = f"sudo bash -lc {shlex.quote(remote_cmd)}"
    cmd, ssh_env = ssh_cmd(args, remote_cmd)
    info(f"SSH → {args.user}@{args.host}")
    print(f"{DIM}   {remote_cmd[:160]}{'…' if len(remote_cmd) > 160 else ''}{RESET}")
    env = {**os.environ, **ssh_env} if ssh_env else None
    return run(cmd, env=env)


def read_remote_file_root(args: argparse.Namespace) -> str | None:
    """读该次部署实际生效的 FILE_ROOT（与服务端 systemd EnvironmentFile 同源，不硬编码）。

    优先级跟 server/src/config.js 一致：/etc/cloudnine/cloudnine.env > server/config.json。
    只有路径在服务器上确实存在且可读才返回，否则返回 None（由调用方大声告警，不静默跳过）。
    """
    read_json = "import json,sys;print(json.load(open(sys.argv[1])).get('fileRoot') or '')"
    probe = (
        f"f={shlex.quote(ENV_FILE)}; v=''; "
        "if [ -f \"$f\" ]; then v=$(grep -E '^FILE_ROOT=' \"$f\" | tail -1 | cut -d= -f2-); fi; "
        f"if [ -z \"$v\" ] && [ -f {DEPLOY_DIR}/server/config.json ]; then "
        f"v=$(python3 -c {shlex.quote(read_json)} {DEPLOY_DIR}/server/config.json 2>/dev/null); fi; "
        "if [ -n \"$v\" ] && [ -e \"$v\" ] && [ -r \"$v\" ]; then printf '%s' \"$v\"; fi; true"
    )
    proc = remote_run(args, probe, as_root=True)
    return (proc.stdout or "").strip().splitlines()[-1].strip() if (proc.stdout or "").strip() else None


def smoke_command(file_root: str | None) -> str:
    """服务器本机执行的冒烟测试命令（只有服务器上才访问得到 FILE_ROOT）。"""
    parts = ["python3", "scripts/smoke_test.py", "--url", "http://127.0.0.1:8480/"]
    if file_root:
        parts += ["--file-root", file_root]
    return f"cd {shlex.quote(DEPLOY_DIR)} && " + " ".join(shlex.quote(p) for p in parts)


def warn_all(lines: list[str]) -> None:
    """成块黄色告警：覆盖缺口必须一眼看到，不能混在一堆日志里。"""
    for line in lines:
        print(f"{YELLOW}{BOLD}  {MARK_WARN} {line}{RESET}", flush=True)


def warn_smoke_without_file_root() -> None:
    """读不到 FILE_ROOT 时把「哪几条用例没跑」明确说清楚，而不是静默跳过。"""
    warn_all([
        "读不到服务端的 FILE_ROOT（env 文件里没有 FILE_ROOT=，或路径不存在/不可读）",
        "本次冒烟测试【未覆盖】这 3 条安全用例：",
        "  1) 软链接文件不能分享（share_symlink）",
        "  2) 路径经过软链不能分享（share_path_unsupported）",
        "  3) 分享后文件被替换成软链 → /file 拒绝",
        "补齐办法：在服务器上确认 FILE_ROOT，然后执行：",
        "  python3 scripts/smoke_test.py --url http://127.0.0.1:8480/ --file-root <FILE_ROOT>",
    ])


def health_check(url: str, retries: int = 12, interval: float = 2.0) -> dict | None:
    for i in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=8) as resp:
                if resp.status == 200:
                    body = resp.read().decode("utf-8", "replace")
                    try:
                        import json

                        return json.loads(body)
                    except Exception:
                        return {"raw": body[:200]}
        except (urllib.error.URLError, OSError) as e:
            if i == retries:
                err(f"健康检查失败: {e}")
                return None
        time.sleep(interval)
    err("健康检查失败：超时")
    return None


def main() -> None:
    # 先载入 .secrets/*.env（SSH_PASSWORD / CN_DEPLOY_HOST / CN_DEPLOY_USER），
    # 这样「直接跑部署脚本」即可完成部署，无需每次再提供密码。
    loaded = load_secrets()
    if loaded:
        info(f"已载入部署凭据: {', '.join(loaded)}（来源 .secrets/*.env）")

    ap = argparse.ArgumentParser(description="CloudNine 部署编排器")
    ap.add_argument("--host", default=os.environ.get("CN_DEPLOY_HOST"),
                    help="目标服务器 IP/域名（默认取环境变量 CN_DEPLOY_HOST）")
    ap.add_argument("--user", default=os.environ.get("CN_DEPLOY_USER", "ubuntu"), help="SSH 用户名")
    ap.add_argument("--port", type=int, default=22, help="SSH 端口")
    ap.add_argument("--key", help="SSH 私钥路径")
    ap.add_argument("--password", action="store_true", help="使用密码登录")
    ap.add_argument("--push", action="store_true", help="部署前先 push 本地提交到 GitHub")
    ap.add_argument("--bootstrap", action="store_true", help="首次部署：执行引导脚本")
    ap.add_argument("--branch", default="main", help="部署分支")
    ap.add_argument("--public-url", help="对外访问 URL（默认 http://HOST/）")
    ap.add_argument("--no-build", action="store_true", help="跳过前端构建")
    ap.add_argument("--skip-smoke", action="store_true", help="跳过部署后的冒烟测试")
    ap.add_argument("--direct", action="store_true",
                    help="服务直连对外（前面没有反向代理）：不写 TRUST_PROXY，忽略代理头")
    args = ap.parse_args()

    if not args.host:
        err("缺少目标服务器：用 --host 指定，或在 .secrets/*.env 里设置 CN_DEPLOY_HOST")
        raise SystemExit(1)

    if args.password:
        args.password = os.environ.get("SSH_PASSWORD", "")
        if not args.password:
            err("--password 需要配合环境变量 SSH_PASSWORD 使用（或直接用 --key 走密钥登录）")
            raise SystemExit(1)

    public_url = args.public_url or f"http://{args.host}/"
    health_url = "http://127.0.0.1:8480/api/state"

    # ---------- 1. 可选：推送本地提交 ----------
    if args.push:
        info("推送本地提交到 GitHub")
        run(["git", "push", "origin", args.branch], cwd=REPO_ROOT)
        ok("已推送")
    else:
        unpushed = subprocess.run(
            ["git", "log", f"origin/{args.branch}..HEAD", "--oneline"],
            cwd=REPO_ROOT, text=True, capture_output=True,
            encoding="utf-8", errors="replace",
        ).stdout or ""
        unpushed = unpushed.strip()
        if unpushed:
            warn(f"本地有未推送的提交（{len(unpushed.splitlines())} 条），远端将不会包含这些改动：")
            for line in unpushed.splitlines():
                print(f"{DIM}     {line}{RESET}")
            warn("如需部署这些改动，请加 --push")

    # ---------- 2. 引导（首次）----------
    if args.bootstrap:
        info("执行首次引导（安装运行时、建账号、配置 systemd/nginx）")
        remote_run(
            args,
            f"cd {REPO_ROOT.name} 2>/dev/null; "
            f"git clone --branch {args.branch} https://github.com/bytesfloow/cloudnine.git /tmp/cloudnine-bootstrap 2>/dev/null "
            f"|| true; "
            f"bash /tmp/cloudnine-bootstrap/scripts/bootstrap.sh",
            as_root=True,
        )
        ok("引导完成")

    # ---------- 2.5 来源 IP 判定 ----------
    # 部署模板前面有 nginx：不告诉应用它在反代后面，req.ip 会永远是 127.0.0.1，
    # 登录限流的 IP 维度会把所有客户端算成同一个来源（已被用户名维度兑底）。
    # 直连部署则相反，必须保持关闭，否则客户端伪造 X-Forwarded-For 即可绕过限流。
    if args.direct:
        info("直连部署：不写 TRUST_PROXY（忽略代理头，防止伪造 X-Forwarded-For）")
    else:
        info("反向代理部署：确保 TRUST_PROXY=1")
        remote_run(
            args,
            f"f={shlex.quote(ENV_FILE)}; mkdir -p \"$(dirname \"$f\")\"; touch \"$f\"; "
            "if grep -q '^TRUST_PROXY=' \"$f\"; then sed -i 's/^TRUST_PROXY=.*/TRUST_PROXY=1/' \"$f\"; "
            "else echo 'TRUST_PROXY=1' >> \"$f\"; fi; grep -n '^TRUST_PROXY=' \"$f\"",
            as_root=True,
        )

    # ---------- 3. 部署 ----------
    info("执行部署")
    flags = " --no-build" if args.no_build else ""
    # 必须把 --branch 传成 DEPLOY_BRANCH：deploy_remote.sh 的 fetch/checkout/pull
    # 都读这个变量（缺省 main）。不传就等于「选了分支但远端照样部署 main」。
    remote_run(
        args,
        f"cd {DEPLOY_DIR} && DEPLOY_BRANCH={shlex.quote(args.branch)} bash scripts/deploy_remote.sh{flags}",
    )

    # ---------- 4. 健康检查 ----------
    info(f"健康检查 {public_url}")
    state = health_check(f"{public_url.rstrip('/')}/api/state")
    if state is None:
        err("部署后健康检查未通过")
        raise SystemExit(1)
    ok(f"服务状态: {state}")

    # ---------- 5. 冒烟测试 ----------
    if not args.skip_smoke:
        # 在服务器本机跑：软链用例要直接在 FILE_ROOT 里造软链，开发机访问不到该路径。
        # FILE_ROOT 从本次部署实际生效的配置里读（env 文件 > server/config.json），不硬编码。
        info("运行 API 冒烟测试（服务器本机，经 127.0.0.1:8480）")
        file_root = read_remote_file_root(args)
        if file_root:
            ok(f"FILE_ROOT = {file_root}（3 条软链用例会真的执行）")
        else:
            warn_smoke_without_file_root()
        smoke = remote_run(args, smoke_command(file_root), as_root=True)
        if smoke.returncode != 0:
            err("冒烟测试未通过")
            raise SystemExit(1)

    print()
    ok(f"部署完成 → {public_url}")
    info("首次访问会进入初始化向导，创建唯一账号")


if __name__ == "__main__":
    main()
