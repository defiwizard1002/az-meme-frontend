FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.0.9 --activate
ARG VITE_MEME_API_BASE_URL=
ARG VITE_MEME_WS_URL=
ARG VITE_AZ_API_BASE_URL=
ENV VITE_MEME_API_BASE_URL=$VITE_MEME_API_BASE_URL VITE_MEME_WS_URL=$VITE_MEME_WS_URL VITE_AZ_API_BASE_URL=$VITE_AZ_API_BASE_URL
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
ENV PORT=5173
EXPOSE 5173
CMD ["node","-e","const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const root=path.resolve('dist');http.createServer((req,res)=>{const u=new URL(req.url||'/', 'http://localhost');const p=path.join(root,u.pathname==='/'?'index.html':u.pathname);const f=fs.existsSync(p)&&fs.statSync(p).isFile()?p:path.join(root,'index.html');fs.createReadStream(f).pipe(res)}).listen(Number(process.env.PORT),'0.0.0.0')"]
