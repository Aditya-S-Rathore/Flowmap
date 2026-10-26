export default {
  name: "backend",
  plugins: ["nestjs", "graphql-sdl", "typeorm", "typeorm-transactional", "bullmq", "http-clients"],
  externals: { MailService: "Mail" },
};
