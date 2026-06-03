/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdfjs-dist 必须 external，否则 worker 文件(pdf.worker.js)在打包后路径丢失，PDF 解析全部失败
    serverComponentsExternalPackages: ['pdf-parse', 'pdfjs-dist'],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // 将pdf-parse标记为external,避免webpack打包
      config.externals = config.externals || []
      if (Array.isArray(config.externals)) {
        config.externals.push('canvas')
      }
    }
    return config
  },
}

export default nextConfig

