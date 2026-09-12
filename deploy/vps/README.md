# VPS one-shot sync

此目录只定义一次性的 VPS 同步容器；它不发布端口、不常驻重启，也不挂载 Docker socket。

在 Linux 主机上复制模板并仅在本机填写真实值：

```sh
cp deploy/vps/.env.example deploy/vps/.env
chmod 600 deploy/vps/.env
```

`VPS_SYNC_IMAGE` 必须是 `ghcr.io/skyline-gazer/airing-cal-sync:` 加完整 40 位小写 Git SHA；不要使用 `latest`、debug 标签或短 SHA。`DATABASE_URL` 与 `R2_*` 是运行期 secrets，不能提交或输出到日志。

先在主机上渲染配置：

```sh
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml config
```

执行计划同步：

```sh
deploy/vps/run-sync.sh live
```

脚本通过 host `flock -n` 取得非阻塞锁；锁已被占用时会以非零状态退出。Linux cron 可以直接调用它，例如：

```cron
0 20 * * * /opt/airing-cal/deploy/vps/run-sync.sh live >> /var/log/airing-cal-sync.log 2>&1
```

容器根文件系统为只读，运行用户为镜像的 `node` 用户；仅 `/tmp/airing-cal` 是可写 tmpfs。
