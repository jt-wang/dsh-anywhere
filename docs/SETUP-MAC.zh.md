# DSH Anywhere：在 Mac 上安装（Apple 芯片或 Intel）

英文完整版见同目录的 `SETUP-MAC.md`。

不会做的事：不重启 DSH，不开防火墙端口，不改系统信任；插件只监听 `127.0.0.1`，不需要 sudo。

## 一条命令安装

装好 DSH Desktop 并打开过一次之后，运行：

```sh
dsh plugin --profile desktop add @jt-wang/dsh-anywhere
```

npm 包名是 `@jt-wang/dsh-anywhere`，一定要带 `@jt-wang/` 前缀：npm 上不带前缀的 `dsh-anywhere` 是另一位作者的插件。
PATH 里没有 `dsh` 时，用 App 自带的
`"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"`。安装时 DSH 会检查版本：支持
`0.2.0-rc.2`、0.2.1 的所有正式版与预发布版，以及 0.2.2 的候选版（rc）与正式版。

DSH 会加载这个插件。插件第一次启动时，在 `~/Library/Application Support/DSHAnywhere/host/` 生成私有的 Tailcat 配置；
那里的 `companion.log` 最后一行是 `running <版本号>` 就说明在运行了。然后在 DSH 里打开 **Settings → DSH Anywhere → Pair a phone**。
卸载：`dsh plugin --profile desktop remove @jt-wang/dsh-anywhere`。

让 AI agent 来装：把 [AGENT-INSTALL.md](../AGENT-INSTALL.md) 交给它，里面有每一步的检查。

## 更新

DSH Desktop 自己会更新：有新版本时，侧边栏「插件」里的 `@jt-wang/dsh-anywhere` 会标出来，点更新即可。一分钟内 `companion.log` 最后一行还不是 `running <新版本号>` 的话，退出并重新打开 DSH Desktop。已配对的手机不用重新配对。

用 GitHub 下载装过 DSH Anywhere 0.1.10 或更早版本的，那个包名叫 `dsh-anywhere`，DSH 没法更新它，需要手动改装一次（见
[AGENT-INSTALL.md 第 7 节](../AGENT-INSTALL.md#7-switch-from-the-github-download)）：先确认装的 `dsh-anywhere` 是 DSH Anywhere
的（不是另一位作者的同名插件），再运行 `dsh plugin --profile desktop remove dsh-anywhere` 和
`dsh plugin --profile desktop add @jt-wang/dsh-anywhere`。配对和数据都保留。

## 配对手机

[下载 Android App](https://github.com/jt-wang/dsh-anywhere/releases/latest/download/dsh-anywhere.apk) 并安装。在 DSH 里打开 **设置 → DSH Anywhere → 配对手机**，用 App 扫码。在同一页可以撤销手机。

## 从源码构建

只有想改代码才需要，见英文版的 [Build and install from source](SETUP-MAC.md#build-and-install-from-source)。
