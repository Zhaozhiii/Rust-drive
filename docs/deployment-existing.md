# 独立云盘

入口：**https://drive.zhiii.top**。Rust/Axum 单进程后端和内嵌文字前端，Nginx 负责 HTTPS 与文件下载；运行时不需要 Node.js、MySQL、Redis 或其它业务服务。

所有访客均可浏览、上传、下载、新建目录和删除。这是本次确认的访问方式。页面只使用文字、原生控件和系统字体，不请求图片、图标、外部字体或第三方资源。

## 功能与接口

保留目录浏览、目录优先排序、文件大小/修改时间、面包屑、上级目录、新建目录、递归删除、同名覆盖、普通 multipart 上传和下载。上传界面支持拖拽、16 MiB 分片、三路并发、每片最多三次尝试、刷新后重选原文件续传、取消，以及进度、速度、耗时与剩余时间。

| 方法 | 路径 | 输入 |
| --- | --- | --- |
| GET | `/api/clouddrive/list` | `?path=` |
| POST | `/api/clouddrive/mkdir` | `?path=`，JSON `{name}` |
| DELETE | `/api/clouddrive/remove` | `?path=` |
| GET | `/api/clouddrive/download` | `?path=`；支持 Range |
| POST | `/api/clouddrive/upload` | `?path=`，multipart `file` |
| POST | `/api/clouddrive/upload-session` | JSON `{path,name,size,lastModified}` |
| GET / DELETE | `/api/clouddrive/upload-session/:id` | 查询 / 取消 |
| PUT | `/api/clouddrive/upload-session/:id/chunk/:index` | 二进制分片 |
| POST | `/api/clouddrive/upload-session/:id/complete` | 完成上传 |
| GET | `/healthz` | 健康状态 |

成功响应沿用旧接口字段。列表包含 `entries,totalSize,maxSize,sub`；会话包含 `id,path,name,size,lastModified,chunkSize,completed`。容量不足返回 507，未上传完返回 409，文件或会话不存在返回 404；业务错误包含 JSON `message`。

`www.zhiii.top` 和 `zhiii.top` 的 `/clouddrive` 页面跳转到新域名，旧 `/api/clouddrive/` 仍保留请求方法与请求体并转发到独立服务。

## 数据与性能

- 数据目录仍为 `/root/blogweb/clouddrive`；`.tmp` 和 `.uploads` 不在列表或下载入口开放。保留历史临时文件，不自动删除未完成会话。
- 总量 10 GiB、单文件 5 GiB；新会话将完整文件大小计入预留量，同名覆盖也需要预留空间。实际磁盘必须另留 2 GiB 给系统。旧 multipart 上传随写入增量预留，避免因上传小文件而先占用 5 GiB 配额。
- 磁盘余量和容量限制共同生效。因此“10 GiB 总量”不保证当前物理磁盘始终能接收 10 GiB。备份约占 1.85 GiB，遗留临时文件约占 0.96 GiB；都已保留。
- 启动扫描容量，成功上传/覆盖/删除后增量更新，每小时后台校准。列表只读取当前目录，不递归扫描全盘；其它程序直接改动文件后，可重启服务立即刷新统计。
- 分片流式写入同一临时文件对应偏移，确认数据同步后持久化完成位图。每个会话的完成/取消与分片互斥，同一分片串行，不同分片可并发。发布最终文件使用同文件系统原子重命名。
- 根目录通过 Linux `openat2` 的根目录约束及禁止符号链接规则访问；删除根目录、保留目录、绝对路径、父目录跳转和符号链接逃逸均被拒绝。Nginx 内部下载也禁用符号链接。
- 后端两个异步工作线程，全局最多六个上传流，写入块不超过 256 KiB；容器内存上限 128 MiB。Nginx 容器上限 64 MiB，动态解析后端地址，支持后端重建与服务器重启。

配置环境变量：`CLOUDDRIVE_ROOT`、`DRIVE_LISTEN`、`DRIVE_MAX_BYTES`、`DRIVE_MAX_FILE_BYTES`、`DRIVE_DISK_RESERVE_BYTES`。后三者以字节为单位；生产使用上述默认值。`--healthcheck` 通过本机 HTTP 检查服务。

## 构建、更新与检查

本地使用 Windows + Ubuntu-24.04 WSL，在本地编译 Linux musl 静态文件；服务器仅将文件打包进 scratch 镜像，不进行编译。Rust 版本见 `rust-toolchain.toml`，全部依赖由 `Cargo.lock` 锁定。Linux 内核需支持 `openat2`；当前服务器为 6.8。

首次配置 WSL 时安装 `build-essential musl-tools pkg-config ca-certificates`、Rustup 和指定版本的 `rustfmt` / `clippy`。

```powershell
cd D:\Projects\Rust-drive
.\deploy\build.ps1
python .\deploy\publish.py
python .\tests\public.py
node .\tests\frontend.cjs https://drive.zhiii.top
```

发布工具从 `DRIVE_SSH_HOST`、`DRIVE_SSH_USER` 和 `DRIVE_SSH_PASSWORD` 环境变量获取连接配置；主机密钥必须已存在于 SSH known_hosts 中。前端测试使用 `npm install` 安装的 Playwright 和本机 Edge，只是开发测试依赖，生产不需要它们。

服务器常用检查：

```sh
docker compose -f /srv/drive-service/compose.yaml ps
docker logs --tail 100 drive-service
docker exec drive-service /drive-service --healthcheck
docker exec blogweb-nginx nginx -t
curl -fsS https://drive.zhiii.top/healthz
```

证书统一由 root 的每日 03:17 定时任务执行 `/bin/sh /srv/drive-service/renew.sh`，日志为 `/var/log/drive-cert-renew.log`。所有保留域名的 ACME 验证路径仍有效。续期演练：

```sh
/bin/sh /srv/drive-service/renew.sh --cert-name drive.zhiii.top --dry-run --no-random-sleep-on-renew
```

`tests/integration.py` 只启动隔离数据目录中的测试服务，覆盖并发、异常上传、重启及容量边界；`tests/public.py` 和 `tests/frontend.cjs` 只创建并删除各自独有的测试目录。`tests/reboot.py` 会实际重启生产服务器，仅用于明确安排的部署验收，本次已运行。

## 暂停状态、备份与恢复

正式运行的业务容器只有 `drive-service` 与 `blogweb-nginx`。`shirone-blog`、`blogweb-client`、`blogweb-server`、`nnnuyy-api`、`blogweb-sadb`、`blogweb-mysql` 和原已停止的 `ai-video-app` 均保留，重启策略为 `no`。相关 API 的备份/续期定时器已暂停，证书改为统一续期；系统维护和远程管理保持运行。其它业务域名返回文字“服务已暂停”和 HTTP 503。

切换前快照位置：`/srv/drive-service/backups/20261025-071544/`，目录仅 root 可访问。包含：

- `clouddrive.tar`：正式文件、空目录及历史临时数据的完整备份。
- `clouddrive.tar.sha256`、`files-before.json`、`files-after.json`、`archive-verified`：归档哈希及逐文件校验记录。
- `mysql.sql.gz`：全部 MySQL 数据库的逻辑备份。
- 原 Nginx / Compose 配置、定时任务和旧站前后端源码。

`/srv/drive-service/deployment-state.json` 保存原容器运行/重启策略和定时任务状态；原入口容器保留为 `blogweb-nginx-before-drive-20261025-071544`。

恢复旧业务及旧入口：

```sh
python3 /srv/drive-service/rollback.py
```

恢复脚本先停止新云盘写入，恢复原入口、容器策略及原定时任务，再启动原本在运行的业务。当前云盘文件继续使用同一目录，不自动用历史归档覆盖新增上传。恢复某个已删除的历史文件时，应先从归档提取到另一个目录，再按需放回。

验收结果与性能数据见 [验收报告](../VERIFICATION.md)；原始记录及界面截图在本地 `artifacts/`。
