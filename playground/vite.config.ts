import path from 'path'

import { defineConfig } from 'vite'

import mkcert from '..'

export default defineConfig({
  root: __dirname,
  plugins: [
    mkcert({
      source: 'local',
      savePath: path.resolve(process.cwd(), 'node_modules/.mkcert')
    })
  ]
})
