#!/usr/bin/env python3
"""CloudNine 插件系统 v1 —— 服务端冒烟测试（只用标准库）。

前置：服务已经用一个**临时数据目录**启动，例如

    DATA_DIR=/tmp/cn-plugins PLUGINS_DIR=/tmp/cn-plugins/plugins \\
    PLUGIN_DATA_DIR=/tmp/cn-plugins/plugin-data PORT=8499 node server/src/index.js

然后：

    python3 scripts/plugins_smoke.py --url http://127.0.0.1:8499 \\
        --plugins-dir /tmp/cn-plugins/plugins

`--plugins-dir` 用来造一个 manifest 非法的插件目录，验证「坏插件只进 invalid，不让列表 500」。
不传就跳过那一项（会打印 SKIP）。

覆盖：未登录 401 / 登录后空列表 / 安装 hello / entryUrl 直取 + CSP sandbox /
错 token 404 / 路径穿越 400-404 / storage 往返 / 超 1MB 413 / 非法 manifest 进 invalid /
install zip 成功与重复 409 / 覆盖安装 / DELETE 后 404 / SDK 公开可取 / 无 storage 权限 403 /
文件关联：fileTypes / defaultFor 的非法取值全部 400、合法值小写化去重、旧 manifest 补空数组。
"""

import argparse
import http.client
import io
import json
import os
import sys
import urllib.parse
import zipfile

USER = "tester"
PASSWORD = "test1234"


# ==================== HTTP ====================

class Client:
    def __init__(self, base):
        u = urllib.parse.urlsplit(base)
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or 80
        self.cookie = None

    def request(self, method, path, body=None, headers=None, auth=True):
        h = {"Accept": "*/*", "Connection": "close"}
        if headers:
            h.update(headers)
        if auth and self.cookie:
            h["Cookie"] = self.cookie
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            h.setdefault("Content-Type", "application/json")
        conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
        try:
            conn.request(method, path, body=body, headers=h)
            res = conn.getresponse()
            data = res.read()
            hdrs = {k.lower(): v for k, v in res.getheaders()}
        finally:
            conn.close()
        if "set-cookie" in hdrs and not self.cookie:
            self.cookie = hdrs["set-cookie"].split(";")[0]
        return res.status, hdrs, data

    def json(self, method, path, body=None, auth=True, headers=None):
        st, hdrs, data = self.request(method, path, body=body, auth=auth, headers=headers)
        try:
            parsed = json.loads(data.decode("utf-8") or "null")
        except Exception:
            parsed = None
        return st, parsed, hdrs, data


# ==================== zip 构造 ====================

def zip_from_dir(root):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _dirs, files in os.walk(root):
            for name in sorted(files):
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, root).replace("\\", "/")
                z.write(full, rel)
    return buf.getvalue()


def zip_flat(files):
    """files: {'plugin.json': {...}, 'index.html': '...'}"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            if isinstance(content, (dict, list)):
                content = json.dumps(content, ensure_ascii=False, indent=2)
            z.writestr(name, content)
    return buf.getvalue()


def zip_wrapped(directory, files):
    """把文件塞进唯一顶层目录（另一种打包习惯）"""
    return zip_flat({f"{directory}/{k}": v for k, v in files.items()})


# ==================== 断言框架 ====================

class Runner:
    def __init__(self):
        self.results = []
        self.failed = 0
        self.skipped = 0

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail))
        if not ok:
            self.failed += 1
        mark = "PASS" if ok else "FAIL"
        line = f"  [{mark}] {name}"
        if detail and not ok:
            line += f"  <- {detail}"
        print(line)
        return ok

    def skip(self, name, why):
        self.skipped += 1
        print(f"  [SKIP] {name}  <- {why}")

    def summary(self):
        total = len(self.results)
        passed = total - self.failed
        print()
        print(f"结果：{passed}/{total} 通过，{self.failed} 失败" + (f"，{self.skipped} 跳过" if self.skipped else ""))
        return 0 if self.failed == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("CLOUDNINE_URL", "http://127.0.0.1:8499"))
    ap.add_argument("--plugins-dir", default=os.environ.get("PLUGINS_DIR", ""),
                    help="服务端 PLUGINS_DIR，用于造一个非法 manifest 目录")
    ap.add_argument("--examples", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "examples", "plugins"))
    args = ap.parse_args()

    hello_dir = os.path.join(args.examples, "hello")
    if not os.path.isdir(hello_dir):
        print(f"找不到示例插件目录：{hello_dir}", file=sys.stderr)
        return 2

    c = Client(args.url)
    r = Runner()

    # ---------- 1. 未登录 ----------
    st, body, _h, _raw = c.json("GET", "/api/plugins", auth=False)
    r.check("未登录 GET /api/plugins 返回 401", st == 401, f"status={st} body={body}")

    # ---------- 2. 初始化 / 登录 ----------
    st, body, _h, _raw = c.json("POST", "/api/init", {"username": USER, "password": PASSWORD}, auth=False)
    if st == 200:
        r.check("POST /api/init 建账号成功", True)
    else:
        st2, body2, _h2, _raw2 = c.json("POST", "/api/login", {"username": USER, "password": PASSWORD}, auth=False)
        r.check("POST /api/login 登录成功", st2 == 200, f"init={st}/{body} login={st2}/{body2}")
    r.check("拿到了会话 cookie", bool(c.cookie), f"cookie={c.cookie}")

    # ---------- 3. 空列表 ----------
    # 先清掉上一次跑剩下的东西（脚本自己的产物），让本脚本可以反复跑
    for pid in ("hello", "noperm"):
        c.json("DELETE", f"/api/plugins/{pid}")
    if args.plugins_dir:
        import shutil
        shutil.rmtree(os.path.join(args.plugins_dir, "badplug"), ignore_errors=True)

    st, body, _h, _raw = c.json("GET", "/api/plugins")
    plugins = (body or {}).get("plugins")
    invalid = (body or {}).get("invalid")
    r.check("登录后 GET /api/plugins 200 且 plugins 为空", st == 200 and plugins == [], f"status={st} body={body}")
    r.check("初始 invalid 为空", invalid == [], f"invalid={invalid}")

    # ---------- 4. 非法 manifest 只进 invalid ----------
    bad_dir = os.path.join(args.plugins_dir, "badplug") if args.plugins_dir else None
    if bad_dir:
        os.makedirs(bad_dir, exist_ok=True)
        with open(os.path.join(bad_dir, "plugin.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "badplug", "name": "坏插件", "version": "1.0.0", "permissions": ["files.read"]}, f, ensure_ascii=False)
        st, body, _h, _raw = c.json("GET", "/api/plugins")
        invalid = (body or {}).get("invalid") or []
        dirs = [x.get("dir") for x in invalid]
        r.check("非法 manifest 不让列表 500", st == 200, f"status={st}")
        r.check("非法 manifest 目录进入 invalid", "badplug" in dirs, f"invalid={invalid}")
        r.check("非法插件不出现在 plugins 列表", all(p.get("id") != "badplug" for p in (body or {}).get("plugins") or []), f"body={body}")
    else:
        r.skip("非法 manifest 进 invalid", "未提供 --plugins-dir/PLUGINS_DIR")

    # ---------- 5. 安装 hello（zip 根目录直接放 plugin.json） ----------
    hello_zip = zip_from_dir(hello_dir)
    st, body, _h, raw = c.json("POST", "/api/plugins/install", hello_zip, headers={"Content-Type": "application/zip"})
    r.check("安装 hello.zip 返回 200 且 id=hello", st == 200 and (body or {}).get("id") == "hello", f"status={st} body={body or raw[:200]}")
    entry_url = (body or {}).get("entryUrl") or ""
    icon_url = (body or {}).get("iconUrl") or ""
    r.check("安装结果带 entryUrl / iconUrl", entry_url.startswith("/pa/") and icon_url.startswith("/pa/"), f"entryUrl={entry_url} iconUrl={icon_url}")
    if not entry_url.startswith("/pa/"):
        print("\n安装没有拿到可用 entryUrl，后续对 /pa 的断言无法进行", file=sys.stderr)
        return r.summary() or 1

    st, body, _h, _raw = c.json("GET", "/api/plugins")
    ids = [p.get("id") for p in (body or {}).get("plugins") or []]
    r.check("列表里出现 hello", st == 200 and "hello" in ids, f"ids={ids}")

    st, body, _h, _raw = c.json("GET", "/api/plugins/hello")
    r.check("GET /api/plugins/hello 返回 200 且字段齐全",
            st == 200 and (body or {}).get("id") == "hello" and "window" in (body or {}) and (body or {}).get("permissions") == ["storage"],
            f"status={st} body={body}")
    st, _b, _h, _raw = c.json("GET", "/api/plugins/nope-not-exist")
    r.check("GET 不存在的插件返回 404", st == 404, f"status={st}")

    # ---------- 6. entryUrl 直取（不带 cookie）+ 沙箱头 ----------
    st, hdrs, raw = c.request("GET", entry_url, auth=False)
    text = raw.decode("utf-8", "replace")
    csp = hdrs.get("content-security-policy", "")
    r.check("entryUrl 不带 cookie 也能取到 HTML", st == 200 and "text/html" in hdrs.get("content-type", "") and "<html" in text.lower(),
            f"status={st} ctype={hdrs.get('content-type')}")
    r.check("entryUrl 响应头含 CSP sandbox", "sandbox" in csp and "allow-scripts" in csp, f"csp={csp!r}")
    r.check("entryUrl 带 nosniff", hdrs.get("x-content-type-options") == "nosniff", f"hdr={hdrs.get('x-content-type-options')!r}")
    r.check("entryUrl 带 Cache-Control: no-cache", hdrs.get("cache-control") == "no-cache", f"hdr={hdrs.get('cache-control')!r}")

    st, hdrs, _raw = c.request("GET", icon_url, auth=False)
    r.check("iconUrl 可直取 svg", st == 200 and "svg" in hdrs.get("content-type", ""), f"status={st} ctype={hdrs.get('content-type')}")

    # ---------- 7. token 不对 / 路径穿越 / 目录 ----------
    parts = entry_url.split("/")  # ['', 'pa', token, id, entry]
    token, pid = parts[2], parts[3]
    bad = "/".join(["", "pa", "0" * len(token), pid, parts[4]])
    st, _h, _raw = c.request("GET", bad, auth=False)
    r.check("错 token 返回 404", st == 404, f"status={st}")

    st, _h, _raw = c.request("GET", f"/pa/{token}/{pid}/../../../../etc/passwd", auth=False)
    r.check("路径穿越（../）返回 400/404", st in (400, 404), f"status={st}")

    st, _h, _raw = c.request("GET", f"/pa/{token}/{pid}/%2e%2e%2f%2e%2e%2fplugin.json", auth=False)
    r.check("路径穿越（%2e%2e%2f）返回 400/404", st in (400, 404), f"status={st}")

    st, _h, _raw = c.request("GET", f"/pa/{token}/{pid}/", auth=False)
    r.check("目录请求不列文件（404）", st == 404, f"status={st}")

    st, _h, _raw = c.request("GET", f"/pa/{token}/{pid}/nope.html", auth=False)
    r.check("不存在的资源 404", st == 404, f"status={st}")

    # ---------- 8. storage 往返 ----------
    st, body, _h, _raw = c.json("GET", "/api/plugins/hello/storage")
    r.check("storage 初始为 null", st == 200 and (body or {}).get("data") is None, f"status={st} body={body}")

    payload = {"count": 7, "name": "点了七次", "nested": {"a": [1, 2, 3]}}
    st, body, _h, _raw = c.json("PUT", "/api/plugins/hello/storage", {"data": payload})
    r.check("PUT storage 返回 ok", st == 200 and (body or {}).get("ok") is True, f"status={st} body={body}")

    st, body, _h, _raw = c.json("GET", "/api/plugins/hello/storage")
    r.check("storage 读回与写入一致", st == 200 and (body or {}).get("data") == payload, f"status={st} body={body}")

    big = {"blob": "x" * (1024 * 1024 + 2048)}
    st, body, _h, _raw = c.json("PUT", "/api/plugins/hello/storage", {"data": big})
    r.check("storage 超 1MB 返回 413", st == 413, f"status={st} body={str(body)[:160]}")

    st, body, _h, _raw = c.json("GET", "/api/plugins/hello/storage")
    r.check("413 之后原数据没被破坏", st == 200 and (body or {}).get("data") == payload, f"status={st} body={str(body)[:160]}")

    # ---------- 9. 重复安装 409 / 覆盖安装 ----------
    st, body, _h, raw = c.json("POST", "/api/plugins/install", hello_zip, headers={"Content-Type": "application/zip"})
    r.check("重复安装同一 zip 返回 409", st == 409, f"status={st} body={body or raw[:160]}")

    st, body, _h, raw = c.json("POST", "/api/plugins/install?overwrite=1", hello_zip, headers={"Content-Type": "application/zip"})
    r.check("带 overwrite=1 覆盖安装返回 200", st == 200 and (body or {}).get("id") == "hello", f"status={st} body={body or raw[:160]}")

    # ---------- 10. 非法 manifest 的 zip 装不进来 ----------
    bad_zip = zip_flat({
        "plugin.json": {"id": "evil", "name": "evil", "version": "1.0.0", "permissions": ["root"]},
        "index.html": "<!doctype html><html><body>evil</body></html>",
    })
    st, body, _h, raw = c.json("POST", "/api/plugins/install", bad_zip, headers={"Content-Type": "application/zip"})
    r.check("未知权限的 zip 被拒绝（400）", st == 400, f"status={st} body={body or raw[:160]}")

    server_zip = zip_flat({
        "plugin.json": {"id": "srv", "name": "srv", "version": "1.0.0", "server": "index.js"},
        "index.html": "<!doctype html><html><body>srv</body></html>",
    })
    st, body, _h, raw = c.json("POST", "/api/plugins/install", server_zip, headers={"Content-Type": "application/zip"})
    r.check("带 server 字段的 zip 被拒绝（400）", st == 400, f"status={st} body={body or raw[:160]}")

    empty_zip = zip_flat({"readme.txt": "no manifest here"})
    st, body, _h, raw = c.json("POST", "/api/plugins/install", empty_zip, headers={"Content-Type": "application/zip"})
    r.check("没有 plugin.json 的 zip 被拒绝（400）", st == 400, f"status={st} body={body or raw[:160]}")

    traverse_zip = zip_flat({
        "plugin.json": {"id": "trav", "name": "trav", "version": "1.0.0"},
        "index.html": "<!doctype html><html><body>trav</body></html>",
        "../evil.txt": "pwned",
    })
    st, body, _h, raw = c.json("POST", "/api/plugins/install", traverse_zip, headers={"Content-Type": "application/zip"})
    r.check("含 ../ 路径的 zip 被拒绝（400）", st == 400, f"status={st} body={body or raw[:160]}")

    many = {"plugin.json": {"id": "many", "name": "many", "version": "1.0.0"}, "index.html": "<html></html>"}
    many.update({f"f{i}.txt": "x" for i in range(210)})
    st, body, _h, raw = c.json("POST", "/api/plugins/install", zip_flat(many), headers={"Content-Type": "application/zip"})
    r.check("条目超过 200 的 zip 被拒绝（400）", st == 400, f"status={st} body={body or raw[:160]}")

    # ---------- 10b. 文件关联字段（fileTypes / defaultFor）的 manifest 校验 ----------
    def assoc_zip(pid, extra):
        manifest = {"id": pid, "name": pid, "version": "1.0.0"}
        manifest.update(extra)
        return zip_flat({"plugin.json": manifest, "index.html": "<html><body>x</body></html>"})

    def expect_400(label, pid, extra):
        s, b, _h, rw = c.json("POST", "/api/plugins/install", assoc_zip(pid, extra), headers={"Content-Type": "application/zip"})
        r.check(label, s == 400, f"status={s} body={b or rw[:160]}")

    expect_400("fileTypes 元素不带点（\"json\"）→ 400", "bad-ext-nodot", {"fileTypes": ["json"]})
    expect_400("fileTypes 元素只有一个点（\".\"）→ 400", "bad-ext-onlydot", {"fileTypes": ["."]})
    expect_400("fileTypes 元素含非法字符（\".js on\"）→ 400", "bad-ext-chars", {"fileTypes": [".js on"]})
    expect_400("fileTypes 元素超过 16 字符 → 400", "bad-ext-long", {"fileTypes": ["." + "a" * 16]})
    expect_400("fileTypes 超过 10 项 → 400", "bad-ext-many",
               {"fileTypes": [f".e{i}" for i in range(11)]})
    expect_400("fileTypes 不是数组 → 400", "bad-ext-type", {"fileTypes": ".json"})
    expect_400("defaultFor 不在 fileTypes 里 → 400", "bad-default",
               {"fileTypes": [".json"], "defaultFor": [".md"]})
    expect_400("defaultFor 但完全没有 fileTypes → 400", "bad-default-only", {"defaultFor": [".json"]})

    # 合法：大小写会被规范成小写，重复项去重
    st, body, _h, raw = c.json("POST", "/api/plugins/install",
                               assoc_zip("extok", {"fileTypes": [".JSON", ".Md", ".json"],
                                                   "defaultFor": [".json"]}),
                               headers={"Content-Type": "application/zip"})
    r.check("带 fileTypes/defaultFor 的 zip 能装上（200）", st == 200 and (body or {}).get("id") == "extok",
            f"status={st} body={body or raw[:160]}")
    r.check("响应里的 fileTypes 已小写化并去重", (body or {}).get("fileTypes") == [".json", ".md"],
            f"fileTypes={(body or {}).get('fileTypes')}")
    r.check("响应里的 defaultFor 原样带出", (body or {}).get("defaultFor") == [".json"],
            f"defaultFor={(body or {}).get('defaultFor')}")

    st, body, _h, _raw = c.json("GET", "/api/plugins")
    listed = next((p for p in (body or {}).get("plugins") or [] if p.get("id") == "extok"), None)
    r.check("列表接口也带出 fileTypes / defaultFor",
            listed is not None and listed.get("fileTypes") == [".json", ".md"] and listed.get("defaultFor") == [".json"],
            f"listed={listed}")

    # 旧 manifest（没有这两个字段）不受影响，服务端补空数组
    st, body, _h, raw = c.json("POST", "/api/plugins/install",
                               assoc_zip("oldplug", {}), headers={"Content-Type": "application/zip"})
    r.check("旧 manifest（没有 fileTypes/defaultFor）仍能安装", st == 200 and (body or {}).get("id") == "oldplug",
            f"status={st} body={body or raw[:160]}")
    r.check("旧 manifest 的 fileTypes / defaultFor 补成空数组",
            (body or {}).get("fileTypes") == [] and (body or {}).get("defaultFor") == [],
            f"body={body}")

    # 已安装目录里 manifest 非法（fileTypes 坏了）→ 只进 invalid，不让列表 500
    if args.plugins_dir:
        bad_assoc = os.path.join(args.plugins_dir, "badassoc")
        os.makedirs(bad_assoc, exist_ok=True)
        with open(os.path.join(bad_assoc, "plugin.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "badassoc", "name": "坏关联", "version": "1.0.0",
                       "fileTypes": ["json"]}, f, ensure_ascii=False)
        st, body, _h, _raw = c.json("GET", "/api/plugins")
        invalids = [x.get("dir") for x in (body or {}).get("invalid") or []]
        r.check("fileTypes 非法的插件目录只进 invalid（列表不 500）",
                st == 200 and "badassoc" in invalids, f"status={st} invalid={invalids}")
        r.check("非法 fileTypes 的插件不出现在 plugins 列表",
                all(p.get("id") != "badassoc" for p in (body or {}).get("plugins") or []), f"body={body}")
    else:
        r.skip("fileTypes 非法的目录进 invalid", "未提供 --plugins-dir/PLUGINS_DIR")

    st, body, _h, raw = c.json("POST", "/api/plugins/install", b"PK\x03\x04" + b"\0" * (9 * 1024 * 1024), headers={"Content-Type": "application/zip"})
    r.check("安装请求体超 8MB 返回 413", st == 413, f"status={st} body={str(body)[:120]}")

    # ---------- 11. 无 storage 权限的插件 → 403（顺带测「唯一顶层目录」打包方式） ----------
    noperm_zip = zip_wrapped("noperm", {
        "plugin.json": {"id": "noperm", "name": "无权限插件", "version": "0.1.0", "permissions": []},
        "index.html": "<!doctype html><html><body>noperm</body></html>",
    })
    st, body, _h, raw = c.json("POST", "/api/plugins/install", noperm_zip, headers={"Content-Type": "application/zip"})
    r.check("唯一顶层目录的 zip 也能安装", st == 200 and (body or {}).get("id") == "noperm", f"status={st} body={body or raw[:160]}")

    st, body, _h, _raw = c.json("GET", "/api/plugins/noperm/storage")
    r.check("没有 storage 权限读 → 403", st == 403, f"status={st} body={body}")
    st, body, _h, _raw = c.json("PUT", "/api/plugins/noperm/storage", {"data": 1})
    r.check("没有 storage 权限写 → 403", st == 403, f"status={st} body={body}")

    # ---------- 12. SDK 公开可取 ----------
    st, hdrs, raw = c.request("GET", "/plugin-sdk/v1/cloudnine.js", auth=False)
    sdk = raw.decode("utf-8", "replace")
    r.check("SDK 不带 cookie 可取", st == 200, f"status={st}")
    r.check("SDK 的 Content-Type 是 javascript", "javascript" in hdrs.get("content-type", ""), f"ctype={hdrs.get('content-type')}")
    r.check("SDK 内容含 cloudnine 挂载点", "window.cloudnine" in sdk and "cn:init" in sdk, f"len={len(sdk)}")

    # ---------- 13. 删除 ----------
    st, body, _h, _raw = c.json("DELETE", "/api/plugins/hello")
    r.check("DELETE hello 返回 ok:true", st == 200 and (body or {}).get("ok") is True, f"status={st} body={body}")
    st, _b, _h, _raw = c.json("GET", "/api/plugins/hello")
    r.check("删除后 GET 插件 → 404", st == 404, f"status={st}")
    st, _h, _raw = c.request("GET", entry_url, auth=False)
    r.check("删除后 entryUrl → 404", st == 404, f"status={st}")

    # ---------- 清理 ----------
    c.json("DELETE", "/api/plugins/noperm")
    c.json("DELETE", "/api/plugins/extok")
    c.json("DELETE", "/api/plugins/oldplug")
    if bad_dir and os.path.isdir(bad_dir):
        import shutil
        shutil.rmtree(bad_dir, ignore_errors=True)
    bad_assoc_dir = os.path.join(args.plugins_dir, "badassoc") if args.plugins_dir else None
    if bad_assoc_dir and os.path.isdir(bad_assoc_dir):
        import shutil
        shutil.rmtree(bad_assoc_dir, ignore_errors=True)

    return r.summary()


if __name__ == "__main__":
    sys.exit(main())
