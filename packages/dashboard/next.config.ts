import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@stripe/sync-engine'],
  serverExternalPackages: ['esbuild'],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || []
      if (Array.isArray(config.externals)) {
        config.externals.push('esbuild')
      }
    }
    return config
  },
}

export default nextConfig
