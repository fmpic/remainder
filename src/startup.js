function loadEnvironment(envPath = '.env') {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function getListenHost(env = process.env) {
  const host = (env.HOST || '127.0.0.1').trim();
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!local && !(env.AUTH_USERNAME?.trim() && env.AUTH_PASSWORD)) {
    throw new Error('非本机监听必须同时配置 AUTH_USERNAME 和 AUTH_PASSWORD');
  }
  return host;
}

module.exports = { loadEnvironment, getListenHost };
