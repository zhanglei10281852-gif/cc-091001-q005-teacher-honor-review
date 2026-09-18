import { ReviewService } from './service.js';
import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
const service = new ReviewService();
const secretaryToken = process.env.SECRETARY_TOKEN
  ? service.adoptToken(process.env.SECRETARY_TOKEN, { role: 'secretary' })
  : service.createSecretaryToken();

const server = createServer(service);
server.listen(port, () => {
  console.log(`评审服务已启动: http://localhost:${port}`);
  console.log(`秘书组令牌（请妥善保管，勿提交仓库）: ${secretaryToken}`);
});
