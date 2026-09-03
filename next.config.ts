import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: ['postgres', '@stellar/stellar-sdk'],
}

export default config
