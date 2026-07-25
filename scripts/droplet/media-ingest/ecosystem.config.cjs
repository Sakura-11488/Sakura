module.exports = {
  apps: [
    {
      name: 'sakura-media-ingest',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      max_memory_restart: '900M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.MEDIA_INGEST_PORT || 3200,
        // Set before running deploy.sh (or in /etc/sakura/media-ingest.env):
        //   MEDIA_INGEST_TOKEN  — admin bearer token (required)
      },
    },
  ],
};
