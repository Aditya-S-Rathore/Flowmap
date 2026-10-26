import type { RouterPack } from "./routes.ts";

/**
 * Router packs: how each framework declares its screens and API routes, as data.
 * Adding a router means adding an entry here (plus a fixture test), not new code.
 */

const CODE = /\.(tsx|jsx|ts|js)$/;
const appDirs = (dir: string) => [dir, `src/${dir}`];

const nextApp = appDirs("app").flatMap((dir) => [
  { dir, kind: "page" as const, file: /^page\.(tsx|jsx|ts|js|mdx)$/, nameInPath: false, exclude: /^_/ },
  { dir, kind: "endpoint" as const, file: /^route\.(ts|js)$/, nameInPath: false, verbs: true, exclude: /^_/ },
]);
const nextPages = appDirs("pages").flatMap((dir) => [
  { dir: `${dir}/api`, kind: "endpoint" as const, file: /\.(ts|js)$/, nameInPath: true, prefix: "/api" },
  { dir, kind: "page" as const, file: CODE, nameInPath: true, exclude: /^(_app|_document|_error|api)(\.|$)/ },
]);

export const ROUTER_PACKS: RouterPack[] = [
  {
    id: "react-router",
    deps: ["react-router-dom", "react-router"],
    config: { componentKeys: ["component", "element", "Component", "lazy"], jsxRoute: true, routeCalls: true },
  },
  {
    id: "next",
    deps: ["next"],
    files: [...nextApp, ...nextPages],
    serverActions: true,
  },
  {
    id: "remix",
    deps: ["@remix-run/react", "@react-router/fs-routes"],
    files: [{ dir: "app/routes", kind: "page", file: CODE, nameInPath: true, flat: true }],
  },
  {
    id: "vue-router",
    deps: ["vue-router"],
    config: { componentKeys: ["component", "components"] },
  },
  {
    id: "nuxt",
    deps: ["nuxt"],
    files: [
      ...["pages", "app/pages"].map((dir) => ({ dir, kind: "page" as const, file: /\.vue$/, nameInPath: true })),
      { dir: "server/api", kind: "endpoint", file: /\.(ts|js)$/, nameInPath: true, prefix: "/api" },
      { dir: "server/routes", kind: "endpoint", file: /\.(ts|js)$/, nameInPath: true },
    ],
  },
  {
    id: "sveltekit",
    deps: ["@sveltejs/kit"],
    files: [
      { dir: "src/routes", kind: "page", file: /^\+page\.svelte$/, nameInPath: false },
      { dir: "src/routes", kind: "endpoint", file: /^\+server\.(ts|js)$/, nameInPath: false, verbs: true },
    ],
  },
  {
    id: "angular",
    deps: ["@angular/router"],
    config: { componentKeys: ["component", "loadComponent"], angularComponents: true },
  },
  {
    id: "tanstack-router",
    deps: ["@tanstack/react-router"],
    config: { componentKeys: ["component"], fileRouteCall: true },
  },
  {
    id: "expo-router",
    deps: ["expo-router"],
    files: appDirs("app").flatMap((dir) => [
      { dir, kind: "endpoint" as const, file: /\+api\.(ts|js)$/, nameInPath: true, verbs: true },
      { dir, kind: "page" as const, file: CODE, nameInPath: true, exclude: /^(_layout|\+html|\+not-found|\+native-intent)(\.|$)|\+api\./ },
    ]),
  },
  {
    id: "react-navigation",
    deps: ["@react-navigation/native"],
    config: { componentKeys: ["screen"], jsxScreen: true, screensObject: true },
  },
  {
    id: "astro",
    deps: ["astro"],
    files: [
      { dir: "src/pages", kind: "page", file: /\.astro$/, nameInPath: true },
      { dir: "src/pages", kind: "endpoint", file: /\.(ts|js)$/, nameInPath: true, verbs: true },
    ],
  },
];
