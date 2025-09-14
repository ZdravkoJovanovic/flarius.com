import { NextConfig } from 'next';
import { Configuration } from 'webpack';

const nextConfig: NextConfig = {
  webpack: (config: Configuration) => {
    config.resolve = config.resolve || {};
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

export default nextConfig;