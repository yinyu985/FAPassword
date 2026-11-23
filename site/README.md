# 官网

Cloudflare Pages 静态站点，线上地址 https://fapassword.pages.dev。

- 站点源码就是本目录的 `index.html` 和 `style.css`，没有构建步骤。
- 部署配置在仓库根目录的 `wrangler.jsonc`：项目名 `fapassword`，输出目录 `./site`。
- Cloudflare 侧使用 Git 集成：推送 `main` 分支即自动部署。Dashboard 中构建命令留空，输出目录填 `site`。
- 需要的静态资源放在 `assets/`。`assets/icon.png` 复制自 `icons/icon128.png`，改动图标时一并复制。

需要手动部署时：

```sh
npx wrangler pages deploy site --project-name fapassword
```