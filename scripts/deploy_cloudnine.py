#!/usr/bin/env python3
"""CloudNine 部署编排器（从开发机执行，驱动远端服务器完成部署）

职责：
  1. 可选：把本地已提交的改动推送到 GitHub
  2. SSH 到目标服务器，拉取代码 → 安装依赖 → 构建 → 重启 → 健康检查
  3. 首次部署时自动走 bootstrap.sh（装 Node/nginx、建账号、配 systemd）
  4. 部署完成后在本地跑一遍 API 冒烟测试

用法：
  # 首次部署
  python3 scripts/deploy_cloudnine.py --host 1.2.3.4 --user ubuntu --bootstrap

  # 常规部署
  python3 scripts/deploy_cloudnine.py --host 1.2.3.4 --user ubuntu

  # 本地有未推送提交时，先推再部署
  python3 scripts/deploy_cloudnine.py --host 1.2.3.4 --user ubuntu --push

连接方式：
  --key <path>   SSH 私钥路径（推荐；默认 ~/.ssh/id_ed25519）
  --password     密码登录（需要系统已安装 sshpass）
  环境变量 SSH_PASSWORD 可替代 --password

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

GREEN, RED, YELLOW, CYAN, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[2m", "\033[0m"


def info(msg: str) -> None:
    print(f"{CYAN}==>{RESET} {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"{GREEN}  ✓{RESET} {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"{YELLOW}  !{RESET} {msg}", flush=True)


def err(msg: str) -> None:
    print(f"{RED}  ✗{RESET} {msg}", flush=True)


def run(cmd: list[str], *, cwd: Path | None = None, check: bool = True,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    info(" $ " + " ".join(shlex.quote(c) for c in cmd))
    proc = subprocess.run(cmd, cwd=cwd, env=env, text=True, capture_output=True)
    if proc.stdout.strip():
        print(proc.stdout.rstrip())
    if proc.stderr.strip():
        print(proc.stderr.rstrip(), file=sys.stderr)
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
    ap = argparse.ArgumentParser(description="CloudNine 部署编排器")
    ap.add_argument("--host", required=True, help="目标服务器 IP/域名")
    ap.add_argument("--user", default="ubuntu", help="SSH 用户名")
    ap.add_argument("--port", type=int, default=22, help="SSH 端口")
    ap.add_argument("--key", help="SSH 私钥路径")
    ap.add_argument("--password", action="store_true", help="使用密码登录")
    ap.add_argument("--push", action="store_true", help="部署前先 push 本地提交到 GitHub")
    ap.add_argument("--bootstrap", action="store_true", help="首次部署：执行引导脚本")
    ap.add_argument("--branch", default="main", help="部署分支")
    ap.add_argument("--public-url", help="对外访问 URL（默认 http://HOST/）")
    ap.add_argument("--no-build", action="store_true", help="跳过前端构建")
    ap.add_argument("--skip-smoke", action="store_true", help="跳过部署后的冒烟测试")
    args = ap.parse_args()

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
        ).stdout.strip()
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

    # ---------- 3. 部署 ----------
    info("执行部署")
    flags = " --no-build" if args.no_build else ""
    remote_run(
        args,
        f"cd /opt/cloudnine && bash scripts/deploy_remote.sh{flags}",
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
        info("运行 API 冒烟测试")
        smoke = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "smoke_test.py"), "--url", public_url],
            cwd=REPO_ROOT, text=True,
        )
        if smoke.returncode != 0:
            err("冒烟测试未通过")
            raise SystemExit(1)

    print()
    ok(f"部署完成 → {public_url}")
    info("首次访问会进入初始化向导，创建唯一账号")


if __name__ == "__main__":
    main()
