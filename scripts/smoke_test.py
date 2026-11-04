#!/usr/bin/env python3
"""CloudNine API 冒烟/回归测试

只用标准库（urllib + http.cookiejar），可在任意 Python 3.8+ 环境直接跑。
覆盖：账号初始化 → 登录 → 文件读写 → 目录操作 → 搜索 → 上传下载 → Range → 分享 → 废纸篓 → 磁盘。

用法：
  python3 scripts/smoke_test.py --url http://1.2.3.4/
  python3 scripts/smoke_test.py --url http://127.0.0.1:8480/ --user admin --password xxx
  python3 scripts/smoke_test.py --url ... --keep   # 保留测试文件，不清理
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

GREEN, RED, YELLOW, CYAN, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[2m", "\033[1m", "\033[0m",
)

PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []


class Client:
    """带 Cookie 会话的极简 HTTP 客户端。"""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            NoRedirect(),
        )

    def request(self, method: str, path: str, *, body=None, raw: bytes | None = None,
                headers: dict | None = None, expect_json: bool = True):
        url = path if path.startswith("http") else f"{self.base}{path}"
        data = raw
        hdrs = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with self.opener.open(req, timeout=30) as resp:
                payload = resp.read()
                status = resp.status
                resp_headers = dict(resp.headers)
        except urllib.error.HTTPError as e:
            payload = e.read()
            status = e.code
            resp_headers = dict(e.headers)
        if not expect_json:
            return status, payload, resp_headers
        text = payload.decode("utf-8", "replace")
        try:
            return status, json.loads(text), resp_headers
        except Exception:
            return status, {"_raw": text[:400]}, resp_headers

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.request("POST", path, body=body, **kw)

    def put(self, path, raw=None, **kw):
        return self.request("PUT", path, raw=raw, **kw)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _cookie(name: str, value: str) -> http.cookiejar.Cookie:
    """构造一个可直接塞进 CookieJar 的 Cookie 对象。"""
    return http.cookiejar.Cookie(
        version=0, name=name, value=value,
        port=None, port_specified=False,
        domain="", domain_specified=False, domain_initial_dot=False,
        path="/", path_specified=True,
        secure=False, expires=None, discard=True,
        comment=None, comment_url=None, rest={"HttpOnly": None}, rfc2109=False,
    )


def check(name: str, cond: bool, detail: str = "") -> bool:
    if cond:
        PASSED.append(name)
        print(f"{GREEN}  ✓{RESET} {name}")
    else:
        FAILED.append((name, detail))
        print(f"{RED}  ✗{RESET} {name}  {YELLOW}{detail}{RESET}")
    return bool(cond)


def section(title: str) -> None:
    print(f"\n{BOLD}{CYAN}▸ {title}{RESET}")


def err(msg: str) -> None:
    print(f"{RED}{BOLD}✗ {msg}{RESET}")


def main() -> int:
    ap = argparse.ArgumentParser(description="CloudNine API 冒烟测试")
    ap.add_argument("--url", default="http://127.0.0.1:8480/", help="站点根地址")
    ap.add_argument("--user", default=None, help="已有账号用户名")
    ap.add_argument("--password", default=None, help="已有账号密码")
    ap.add_argument("--keep", action="store_true", help="保留测试产生的文件")
    ap.add_argument("--save-creds", help="把新建的测试账号写入该文件")
    ap.add_argument("--session", help="直接使用已有会话 token（跳过登录，用于测试已部署实例）")
    args = ap.parse_args()

    c = Client(args.url)
    stamp = str(int(time.time()))
    test_dir = f".smoketest_{stamp}"
    test_file = f"{test_dir}/hello.txt"
    payload = "CloudNine 冒烟测试内容 ✅\n第二行\n"

    print(f"{BOLD}CloudNine 冒烟测试{RESET}  目标: {args.url}")

    # ---------- 1. 服务可达 ----------
    section("服务可达性")
    st, body, _ = c.get("/api/state")
    if not check("GET /api/state 返回 200", st == 200, f"status={st}"):
        print(f"{RED}服务不可达，终止{RESET}")
        return 1
    check("返回结构含 siteName", isinstance(body, dict) and "siteName" in body, str(body)[:120])

    # ---------- 2. 账号与登录 ----------
    section("账号与登录")
    # CloudNine 是单用户单账号模型：账号一旦创建不可再建。
    # 因此未初始化时创建，已初始化时必须用已有账号登录。
    user = args.user
    password = args.password

    if args.session:
        # 直接注入已有会话（测试已部署实例时无需账号密码）
        c.jar.set_cookie(_cookie("cloudnine_sid", args.session))
        st, rbody, _ = c.get("/api/state")
        check("注入会话有效", st == 200 and bool(rbody.get("user")), f"status={st} {rbody}")
        user = user or (rbody.get("user") if isinstance(rbody.get("user"), str) else "session")
    elif not user:
        if not body.get("initialized"):
            user = f"smoke_{stamp}"
            password = f"Smoke{stamp}Pass!"
            st, rbody, _ = c.post("/api/init", {"username": user, "password": password})
            if st == 200 and rbody.get("ok"):
                check("POST /api/init 初始化账号", True)
                print(f"{DIM}    测试账号: {user} / {password}{RESET}")
                if args.save_creds:
                    Path(args.save_creds).write_text(f"{user}\n{password}\n", encoding="utf-8")
                    print(f"{DIM}    已保存到 {args.save_creds}{RESET}")
            else:
                check("POST /api/init 初始化账号", False, f"status={st} {rbody}")
                return 1
        else:
            # 已初始化：尝试常见测试账号
            candidates = [
                ("smoke", "smoke1234"),
                ("admin", "admin1234"),
                ("admin", "admin"),
                ("test", "test1234"),
            ]
            print(f"{YELLOW}  !{RESET} 服务已初始化（单账号模型），尝试常见测试账号…")
            logged = False
            for cu, cp in candidates:
                st, rbody, _ = c.post("/api/login", {"username": cu, "password": cp})
                if st == 200 and rbody.get("ok"):
                    user, password, logged = cu, cp, True
                    print(f"{DIM}    命中已有账号: {cu}{RESET}")
                    break
            if not logged:
                err("服务已初始化且无法登录。请用 --user/--password 指定已有账号，"
                    "或清空数据目录的 db.json 后重跑。")
                return 1
    else:
        check("跳过初始化（使用已有账号）", True)

    if not args.session:
        st, rbody, _ = c.post("/api/login", {"username": user, "password": password})
        check("POST /api/login 登录成功", st == 200 and rbody.get("ok"), f"status={st} {rbody}")

        st, body, _ = c.get("/api/state")
        check("会话有效（state 返回用户）", st == 200 and body.get("user"), f"status={st} {body}")

        # 错误密码应被拒绝
        st, rbody, _ = c.post("/api/login", {"username": user, "password": "wrong-password-xyz"})
        check("错误密码被拒绝", st in (401, 403, 400), f"status={st} {rbody}")

        # 重新登录（错误密码可能清了会话）
        c.post("/api/login", {"username": user, "password": password})

    # ---------- 3. 文件系统 ----------
    section("文件系统")
    st, body, _ = c.get("/api/fs/list?path=/")
    check("GET /api/fs/list 根目录", st == 200 and "entries" in body, f"status={st} {body}")

    st, body, _ = c.post("/api/fs/mkdir", {"path": test_dir})
    check("POST /api/fs/mkdir 建目录", st == 200 and body.get("ok"), f"status={st} {body}")

    st, body, _ = c.post("/api/fs/touch", {"path": test_file})
    check("POST /api/fs/touch 建文件", st == 200 and body.get("ok"), f"status={st} {body}")

    st, body, _ = c.post("/api/fs/write", {"path": test_file, "content": payload})
    check("POST /api/fs/write 写入内容", st == 200 and body.get("ok"), f"status={st} {body}")

    st, body, _ = c.get(f"/api/fs/read?path={urllib.parse.quote(test_file)}")
    check("GET /api/fs/read 读回内容一致", st == 200 and body.get("content") == payload,
          f"status={st} got={str(body.get('content'))[:80]!r}")

    st, body, _ = c.get(f"/api/fs/stat?path={urllib.parse.quote(test_file)}")
    check("GET /api/fs/stat 大小正确", st == 200 and body.get("size") == len(payload.encode()),
          f"status={st} {body}")

    # 路径穿越防护
    st, body, _ = c.get("/api/fs/read?path=../../etc/passwd")
    check("路径穿越被拦截（../etc/passwd）", st in (400, 403, 404), f"status={st} {body}")

    # 搜索
    st, body, _ = c.get(f"/api/fs/search?path=/&q=hello.txt")
    found = any(r.get("name") == "hello.txt" for r in body.get("results", [])) if st == 200 else False
    check("GET /api/fs/search 搜到文件", st == 200 and found, f"status={st} {str(body)[:150]}")

    # 复制 / 移动 / 重命名
    st, body, _ = c.post("/api/fs/copy", {"paths": [test_file], "dest": f"{test_dir}/copy", "policy": "rename"})
    check("POST /api/fs/copy 复制文件", st == 200 and body.get("ok"), f"status={st} {body}")

    st, body, _ = c.post("/api/fs/rename", {"path": f"{test_dir}/hello.txt", "newName": "renamed.txt"})
    check("POST /api/fs/rename 重命名", st == 200 and body.get("ok"), f"status={st} {body}")

    st, body, _ = c.post("/api/fs/move", {"paths": [f"{test_dir}/renamed.txt"], "dest": f"{test_dir}/copy", "policy": "rename"})
    check("POST /api/fs/move 移动文件", st == 200 and body.get("ok"), f"status={st} {body}")

    # ---------- 4. 上传下载 ----------
    section("上传与下载")
    up_content = ("分片上传测试 " * 200).encode("utf-8")
    st, body, _ = c.post("/api/upload/init", {
        "destDir": test_dir, "name": "upload.bin", "size": len(up_content), "policy": "rename",
    })
    upload_ok = st == 200 and body.get("uploadId")
    check("POST /api/upload/init 创建上传会话", upload_ok, f"status={st} {body}")

    if upload_ok:
        uid = body["uploadId"]
        half = len(up_content) // 2
        st, body, _ = c.put(f"/api/upload/chunk/{uid}", raw=up_content[:half],
                            headers={"Content-Type": "application/octet-stream"})
        check("PUT /api/upload/chunk 第 1 片", st == 200 and body.get("offset") == half, f"status={st} {body}")

        st, body, _ = c.put(f"/api/upload/chunk/{uid}", raw=up_content[half:],
                            headers={"Content-Type": "application/octet-stream"})
        check("PUT /api/upload/chunk 第 2 片", st == 200 and body.get("offset") == len(up_content), f"status={st} {body}")

        st, body, _ = c.post(f"/api/upload/finish/{uid}")
        check("POST /api/upload/finish 完成上传", st == 200 and body.get("size") == len(up_content), f"status={st} {body}")

        st, raw, _ = c.get(f"/api/download?path={urllib.parse.quote(f'{test_dir}/upload.bin')}", expect_json=False)
        check("GET /api/download 内容一致", st == 200 and raw == up_content, f"status={st} len={len(raw)}")

        # Range 断点下载
        st, raw, hdrs = c.request("GET", f"/api/download?path={urllib.parse.quote(f'{test_dir}/upload.bin')}",
                                  headers={"Range": "bytes=0-9"}, expect_json=False)
        check("Range 下载返回 206 局部内容", st == 206 and raw == up_content[:10], f"status={st} len={len(raw)}")

    # ---------- 5. 分享 ----------
    section("文件分享")
    created_shares: list[str] = []   # 结束时删除，避免在生产环境留下垃圾
    # 注意：前面已把 hello.txt 重命名并移走，这里分享仍然存在的上传产物
    share_target = f"{test_dir}/upload.bin"
    st, body, _ = c.post("/api/shares", {"path": share_target, "expiresIn": 3600, "allowDownload": True})
    share_ok = st == 200 and body.get("share", {}).get("token")
    check("POST /api/shares 创建分享", share_ok, f"status={st} {body}")

    if share_ok:
        token = body["share"]["token"]
        created_shares.append(body["share"]["id"])
        st, body, _ = c.get(f"/api/share/{token}/meta")
        check("GET /api/share/<token>/meta 公开元信息", st == 200 and body.get("name"), f"status={st} {body}")

        st, raw, _ = c.get(f"/api/share/{token}/file?path=upload.bin", expect_json=False)
        check("GET /api/share/<token>/file 下载内容一致", st == 200 and raw == up_content, f"status={st} len={len(raw)}")

        st, body, _ = c.get("/api/shares")
        check("GET /api/shares 管理列表", st == 200 and "shares" in body, f"status={st} {body}")

        # 带密码的分享：无密码必须被拒，正确密码才放行
        st, body, _ = c.post("/api/shares", {"path": share_target, "password": "share-pass-123"})
        if st == 200 and body.get("share", {}).get("token"):
            ptoken = body["share"]["token"]
            st2, body2, _ = c.get(f"/api/share/{ptoken}/meta")
            check("带密码分享：无密码访问被拒 401",
                  st2 == 401 and body2.get("code") == "need_password", f"status={st2} {body2}")

            st3, body3, _ = c.get(f"/api/share/{ptoken}/meta",
                                  headers={"x-share-password": "share-pass-123"})
            check("带密码分享：正确密码放行且声明 requiresPassword",
                  st3 == 200 and body3.get("requiresPassword") is True, f"status={st3} {body3}")

            st4, body4, _ = c.get(f"/api/share/{ptoken}/meta",
                                  headers={"x-share-password": "wrong"})
            check("带密码分享：错误密码被拒 401", st4 == 401, f"status={st4} {body4}")
            created_shares.append(body["share"]["id"])

    # ---------- 6. 废纸篓 ----------
    section("废纸篓")
    st, body, _ = c.post("/api/fs/trash", {"paths": [f"{test_dir}/copy"]})
    check("POST /api/fs/trash 移入废纸篓", st == 200 and body.get("count") == 1, f"status={st} {body}")

    st, body, _ = c.get("/api/fs/trash/list")
    entries = body.get("entries", []) if st == 200 else []
    hit = [e for e in entries if e.get("origRel") == f"{test_dir}/copy"]
    check("GET /api/fs/trash/list 废纸篓可见", st == 200 and bool(hit), f"status={st} {str(body)[:150]}")

    if hit:
        st, body, _ = c.post("/api/fs/trash/restore", {"ids": [hit[0]["id"]]})
        check("POST /api/fs/trash/restore 还原", st == 200 and body.get("restored"), f"status={st} {body}")

    # ---------- 7. 磁盘监控 ----------
    section("磁盘监控")
    st, body, _ = c.get("/api/disk")
    check("GET /api/disk 挂载点信息", st == 200 and body.get("mounts"), f"status={st} {body}")

    # ---------- 8. 清理 ----------
    if not args.keep:
        section("清理")
        # 删除测试期间创建的分享，避免在生产环境留下公开可访问的链接
        for sid in created_shares:
            st, body, _ = c.request("DELETE", f"/api/shares/{sid}")
            check(f"删除测试分享 {sid[:8]}", st == 200, f"status={st} {body}")

        st, body, _ = c.post("/api/fs/trash", {"paths": [test_dir]})
        check("清理测试目录", st == 200, f"status={st} {body}")

        # 把测试产生的废纸篓条目彻底删除（默认保留 30 天，会一直留在废纸篓里）
        st, body, _ = c.get("/api/fs/trash/list")
        for e in body.get("entries", []) if st == 200 else []:
            if e.get("origRel", "").startswith(".smoketest_"):
                c.post("/api/fs/trash/delete", {"ids": [e["id"]]})

        st, body, _ = c.get("/api/fs/trash/count")
        print(f"{DIM}    废纸篓当前条目: {body.get('count')}{RESET}")

    # ---------- 汇总 ----------
    total = len(PASSED) + len(FAILED)
    print()
    if FAILED:
        print(f"{RED}{BOLD}失败 {len(FAILED)}/{total}{RESET}")
        for name, detail in FAILED:
            print(f"  {RED}✗{RESET} {name}  {DIM}{detail}{RESET}")
        return 1
    print(f"{GREEN}{BOLD}全部通过 {total}/{total}{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
