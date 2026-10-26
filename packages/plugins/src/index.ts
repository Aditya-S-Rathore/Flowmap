import type { FlowMapPlugin } from "@flowmap/core";
import { nestjs } from "./nestjs.ts";
import { typeorm } from "./typeorm.ts";
import { typeormTransactional } from "./typeorm-transactional.ts";
import { graphqlSdl } from "./graphql-sdl.ts";
import { bullmq } from "./bullmq.ts";
import { httpClients } from "./http-clients.ts";
import { reduxThunk } from "./redux-thunk.ts";
import { apollo } from "./apollo.ts";
import { drizzle, prisma } from "./orms.ts";
import { routerPlugin } from "./routes.ts";
import { ROUTER_PACKS } from "./router-packs.ts";
import { serverPlugins } from "./servers.ts";
import { pythonPlugins } from "./python.ts";

export const builtinPlugins: FlowMapPlugin[] = [
  nestjs, graphqlSdl, typeorm, typeormTransactional, bullmq, httpClients, reduxThunk, apollo, prisma, drizzle,
  ...ROUTER_PACKS.map(routerPlugin),
  ...serverPlugins,
  ...pythonPlugins,
];

export const pluginRegistry = new Map(builtinPlugins.map((p) => [p.id, p]));

export { rootFields } from "./apollo.ts";
export { fileRoute, linkKey } from "./routes.ts";
export { ROUTER_PACKS } from "./router-packs.ts";
