// A backend-only system of four services in one workspace (no frontend).
export default {
  name: "shop-services",
  repos: [
    { name: "orders", path: "./orders", plugins: ["express", "http-clients"] },
    { name: "billing", path: "./billing", plugins: ["fastapi", "sqlalchemy", "celery"] },
    { name: "accounts", path: "./accounts", plugins: ["django"] },
    { name: "notify", path: "./notify", plugins: ["flask"] },
  ],
};
