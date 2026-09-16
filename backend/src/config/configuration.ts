export default () => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    name: process.env.DB_NAME ?? 'ai_chat_mvp',
    synchronize: process.env.DB_SYNCHRONIZE !== 'false',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
  },
  admin: {
    email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
    password: process.env.ADMIN_PASSWORD ?? 'admin1234',
  },
  ai: {
    requestTimeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? '60000', 10),
    // How often an in-flight generation flushes partial content to the DB.
    // Bounds the text a crash can lose to roughly one interval of tokens.
    persistIntervalMs: parseInt(process.env.AI_PERSIST_INTERVAL_MS ?? '1500', 10),
  },
});
