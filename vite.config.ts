import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  server: { port: 5173, strictPort: false },
  build: {
    rollupOptions: {
      output: {
        // Vendor libraries shared by every route group into their own cacheable
        // chunks instead of inflating the page chunks (and the main bundle).
        // Route pages themselves are lazy imports from src/app/App.tsx.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('@dnd-kit')) return 'vendor-dnd'
          if (id.includes('lucide-react')) return 'vendor-icons'
          if (id.includes('posthog')) return 'vendor-analytics'
          if (id.includes('/motion') || id.includes('framer-motion')) return 'vendor-motion'
          if (id.includes('react-query') || /(^|[\\/])react(-dom)?[\\/]|react-router/.test(id)) return 'vendor-react'
        },
      },
    },
  },
})
