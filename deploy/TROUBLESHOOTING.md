# NapCat 容器排障（实测 + 上游文档）

这些结论来自在 Debian 13 上部署 `mlikiowa/napcat-docker` 时踩到的真实问题。

## 症状与根因对照

| 症状 | 根因 | 判据 |
|---|---|---|
| 宿主机 `ss` 看到 3001/3002 在监听，但 `curl` 返回 000 | **没登录**。OneBot 适配器要等 QQ 登录成功才启动监听；没登录时那些端口只是 podman 的空转发 | 容器内 `cat /proc/net/tcp` 里没有 `0BB9`(3001)/`0BBA`(3002)；容器内 `curl` 返回 000 |
| 改了 `onebot11.json` 但 HTTP 不生效 | 登录过之后，NapCat 读**账号级**配置 `onebot11_<QQ号>.json`，忽略全局模板 | `ls config/` 里存在 `onebot11_<QQ号>.json` |
| 运行中改配置，重启后改动消失 | NapCat 把配置载入内存，退出时用内存里的旧值覆盖文件 | 文件 mtime 在改动后又被回写 |
| 容器退出码 137、重启就掉登录 | `podman restart` 对不响应 SIGTERM 的 QQ 升级为 SIGKILL | `OOMKilled=false` 且日志有 SIGKILL 痕迹 |

## 改配置的正确顺序

**必须先停进程，再改文件，再启动** —— 运行中改会被内存覆盖。

```bash
deploy/napcat.sh stop        # stop -t 60，别用 podman restart
# 改 config/onebot11_<QQ号>.json（httpServers 的 host 必须是 0.0.0.0）
deploy/napcat.sh start
```

## 配置要点

- `host` 必须是 `"0.0.0.0"`。写 `127.0.0.1` 时容器内的 loopback 与 podman 的端口转发对不上，外部必然连不上。
- `port` 必须是数字，不是字符串。
- `httpServers` 必须在 `network` 下面。
- 容器要 `-p` 映射对应端口，否则宿主机连不上。

## 状态判断（别只看 `podman ps`）

容器 `Up` 不等于服务就绪 —— QQ 进程可能还在等扫码。

```bash
podman logs napcat 2>&1 | grep -aE "二维码解码URL|适配器初始化完成|HTTP Server"
```

出现 `[AdapterManager] OneBot11 适配器初始化完成` 才算登录成功、适配器起来了。

## 登录态为什么保不住

QQ 的登录凭证落在 `~/napcat/qq/nt_qq_<hash>/`（约 123 MB），**扫码一次后数据在**，
但容器重启后 QQ 客户端不会自动用它 —— 需要 QuickLogin 或重新扫码。

`-e ACCOUNT=<QQ号>` 这条路实测会让 worker 崩溃（退出码 11，3 次后主进程退出），
不要用。正确变量是 `NAPCAT_QUICK_ACCOUNT` + `NAPCAT_QUICK_PASSWORD`（未在本部署验证）。
