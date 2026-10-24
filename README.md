# Rust-drive

**主打极致低占用的自托管网盘。空闲后端 RSS 实测 1.56 MiB，三路分片上传峰值 4.73 MiB。**

Rust + Axum + Tokio 单进程后端，内嵌纯文字界面，Nginx 交付下载。不依赖 Node.js、数据库、Redis、图片、图标、外部字体或第三方前端脚本。把资源留给文件。

## 为什么轻

- 约 **1.41 MiB** 的 Linux musl 静态可执行文件；两个异步工作线程。
- 上传有界流式写盘，每次写入不超过 256 KiB；16 MiB 分片直接写入同一个临时文件，无需再拼接一份大文件。
- 启动扫描一次容量，上传、覆盖、删除后增量更新，每小时校准；列目录不递归扫描整个网盘。
- 下载使用 Nginx `X-Accel-Redirect`，支持 Range、断点下载与中文文件名。
- 前端只有 HTML、少量 CSS 和原生 JavaScript，无构建步骤。

## 实测资源占用

同机、48 MiB 测试文件、16 MiB 分片、三路并发，三轮中位数。RSS 为后端主进程，不包含 Nginx、容器页缓存及操作系统。上传直连本机后端，下载通过本机 Nginx；吞吐是回环实测，不代表公网速度，也不是所有硬件上的保证。

| 指标 | 原 Node.js 后端 | Rust-drive |
| --- | ---: | ---: |
| 空闲 RSS | 41.16 MiB | **1.56 MiB** |
| 上传峰值 RSS | 62.88 MiB | **4.73 MiB** |
| 上传吞吐 | 210.19 MiB/s | **339.02 MiB/s** |
| 下载吞吐 | 197.33 MiB/s | **493.97 MiB/s** |
| 列表响应中位数 | 1.29 ms | **0.67 ms** |

完整测试条件、验收项目与限制见 [验收记录](VERIFICATION.md)。这些数据来自已部署的初始版本，不应外推为通用性能承诺。

## 功能

- 目录浏览、面包屑、返回上级、新建目录、目录优先排序、大小和修改时间。
- 文件下载、递归删除、同名原子覆盖、中文及特殊字符文件名。
- 选择或拖拽上传、三路并发、每片最多三次尝试；百分比、速度、耗时和预计剩余时间。
- 刷新后重选原文件续传、服务重启后续传、取消上传；上传会话与分片状态落盘。
- 乱序和重复分片处理、同片并发互斥、完成与取消协调。
- 默认总容量 10 GiB、单文件 5 GiB、系统保留空间 2 GiB；计入未完成上传预留量，同时检查物理磁盘余量。
- Linux `openat2` 路径约束、禁止符号链接逃逸、拒绝根目录删除、隐藏保留目录。

**当前版本完全公开，无登录和权限控制。任何能访问服务的人都能上传和删除文件。** 这是产品当前的访问模式；需要私有访问时，请在入口配置认证或限制网络访问。未完成上传不会自动过期，取消任务可释放对应临时空间。

## 快速开始（Linux）

需要支持 `openat2` 的 Linux 内核（5.6+）及 `rust-toolchain.toml` 指定的 Rust 工具链。下载必须由 Nginx 处理，仅启动后端不足以交付文件内容。

```sh
git clone https://github.com/Zhaozhiii/Rust-drive.git
cd Rust-drive
cargo build --release --locked
mkdir -p data
CLOUDDRIVE_ROOT="$PWD/data" DRIVE_LISTEN=127.0.0.1:3104 ./target/release/drive-service
```

另一个终端启动 Nginx；最小配置见 [examples/nginx.conf](examples/nginx.conf)，替换 `/absolute/path/to/data/` 为上面数据目录的绝对路径。配置中默认监听 8080，浏览器访问 `http://localhost:8080`。正式部署请自行配置域名和 HTTPS。

后端内部程序名仍为 `drive-service`，避免破坏现有容器和运维脚本。项目和仓库名称为 **Rust-drive**。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOUDDRIVE_ROOT` | `/root/blogweb/clouddrive` | 建议显式设置自己的数据目录 |
| `DRIVE_LISTEN` | `127.0.0.1:3104` | 后端监听地址 |
| `DRIVE_MAX_BYTES` | `10737418240` | 总逻辑容量，字节 |
| `DRIVE_MAX_FILE_BYTES` | `5368709120` | 单文件上限，字节 |
| `DRIVE_DISK_RESERVE_BYTES` | `2147483648` | 系统磁盘保留量，字节 |

`/healthz` 提供健康检查，`drive-service --healthcheck` 可用于容器探活。配额上限与可用物理空间同时生效；覆盖文件也需要临时空间。

## 开发和验证

```sh
cargo fmt --check
cargo clippy --locked -- -D warnings
cargo test --locked
cargo build --release --locked
python3 tests/integration.py target/release/drive-service
```

集成测试使用临时数据目录，覆盖路径边界、并发分片、覆盖、取消竞争、重启续传及容量限制。Windows 可通过 WSL 运行 [deploy/build.ps1](deploy/build.ps1)，生成 musl 静态文件。浏览器验收需要 Node.js（仅测试）：`npm ci`，然后 `npm run test:frontend -- https://your-drive.example`；默认使用本机 Edge。

`deploy/` 中的 stage、activate、rollback 和证书脚本是原站迁移工具，会涉及原站容器与定时任务，不能当作通用一键安装。原部署维护说明见 [部署记录](docs/deployment-existing.md)。远程连接使用 `DRIVE_SSH_HOST`、`DRIVE_SSH_USER`、`DRIVE_SSH_PASSWORD` 或 SSH agent，源码不保存凭据。

## API

保持 `/api/clouddrive/` 接口兼容。文件路径相对数据根目录，JSON 错误含 `message`。

| 方法 | 路径 | 输入 |
| --- | --- | --- |
| GET | `/api/clouddrive/list` | `?path=` |
| POST | `/api/clouddrive/mkdir` | `?path=`，JSON `{name}` |
| DELETE | `/api/clouddrive/remove` | `?path=` |
| GET | `/api/clouddrive/download` | `?path=`；由 Nginx 交付 |
| POST | `/api/clouddrive/upload` | `?path=`，multipart `file` |
| POST | `/api/clouddrive/upload-session` | JSON `{path,name,size,lastModified}` |
| GET / DELETE | `/api/clouddrive/upload-session/:id` | 查询 / 取消 |
| PUT | `/api/clouddrive/upload-session/:id/chunk/:index` | 二进制分片 |
| POST | `/api/clouddrive/upload-session/:id/complete` | 完成上传 |

容量不足返回 507，未传完返回 409，不存在返回 404。列表成功字段包括 `entries,totalSize,maxSize,sub`；会话包括 `id,path,name,size,lastModified,chunkSize,completed`。
