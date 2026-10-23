import { defineConfig } from "vite";
// index.html 1ファイルのアプリ。Vite は .env の VITE_SUPABASE_* を index.html の %VITE_…% に差し込むためだけに使う
export default defineConfig({ server: { host: "::", port: 8080 } });
