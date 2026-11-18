import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vite only exposes env variables with these prefixes to the browser (via import.meta.env).
  // NEXT_PUBLIC_ is added so the Supabase variables can use that naming. Anything with either
  // prefix ends up in the public JS bundle, so NEVER give a secret (e.g. the service_role key) one.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
})
