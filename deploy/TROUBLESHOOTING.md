# NapCat 容器排障（全部为 noco 现场实测）

## 一、重启免扫码：三条缺一不可

实测做法（`deploy/napcat.sh` 已固化）：

```bash
podman run -d --name napcat --restart=unless-stopped \
  --network=bridge --mac-address=<固定MAC> \
  -e NAPCAT_QUICK_ACCOUNT=<QQ号> -e NAPCAT_QUICK_PASSWORD=<密码> \
  -v ~/napcat/qq:/app/.config/QQ -v ~/napcat/config:/app/napcat/config ...
```

| 条件 | 缺了会怎样 |
|---|---|
| 持久化 `/app/.config/QQ` | 登录凭证与设备指纹丢失（约 90 MB），必然重扫 |
| 固定 MAC（`--mac-address`） | 容器重建换 MAC，QQ 判成新设备，凭证当场作废 |
| `NAPCAT_QUICK_ACCOUNT` + `NAPCAT_QUICK_PASSWORD` | 只出二维码，不自动登录 |

实测结果：连续两次 `stop -t 60` + `start`，日志均出现
`[NapCat] [WebUi] 自动快速登录成功: <QQ号>`，随后 OneBot 适配器就绪、HTTP 200。

**注意**：`--mac-address` 必须配 `--network=bridge`，否则报
`invalid config provided: networks and static ip/mac address can only be used with Bridge mode networking`。

## 二、HTTP/WS 端口「在听但连不上」

**根因几乎总是没登录。** OneBot 适配器要等 QQ 登录成功才启动监听；
没登录时宿主机 `ss` 看到的 3001/3002 只是 podman 的空转发。

判据：
- 容器内 `cat /proc/net/tcp` 里没有 `0BB9`(3001) / `0BBA`(3002)
- 容器内 `curl` 返回 000
- 日志没有 `[OneBot] [HTTP Server Adapter] Start On ...`

## 三、配置改了不生效

登录过之后 NapCat 读**账号级**配置 `config/onebot11_<QQ号>.json`，
全局 `onebot11.json` 被忽略。改错文件是最常见的白费功夫。

另外运行中改配置会被内存里的旧值覆盖 —— 必须**停进程 → 改文件 → 启动**。

## 四、`podman restart` 会毁掉登录态

QQ 不响应 SIGTERM，podman 等 10 秒升级为 SIGKILL（退出码 137，`OOMKilled=false`），
登录态跟着丢。用 `podman stop -t 60` 再 `start`。

## 五、不要用的配置

`-e ACCOUNT=<QQ号>`：实测让 worker 崩溃（退出码 11，10 秒内 3 次后主进程退出）。
正确环境变量是 `NAPCAT_QUICK_ACCOUNT`。
