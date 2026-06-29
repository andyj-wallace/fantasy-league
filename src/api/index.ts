import "dotenv/config";
import { startLocalApiServer } from "./localServer";

const port = Number(process.env.PORT ?? 3001);

startLocalApiServer(port);
