import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import net from "node:net";

/** Порт службы (core_ipc::ADDR). Дублируется здесь только ради разработки. */
const SERVICE_PORT = 48291;

/**
 * Мост «браузер → служба» для разработки. Служба говорит построчным JSON по
 * TCP, из браузера туда не дотянуться, а через Tauri — можно. Чтобы `pnpm dev`
 * показывал живой интерфейс, а не заглушку, дев-сервер сам ходит в службу.
 * В собранном приложении этого моста нет: там всегда invoke() Tauri.
 */
function serviceBridge(): Plugin {
  return {
    name: "pg-service-bridge",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/ipc", (req, res) => {
        const fail = (message: string) => {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ reply: "error", data: { message } }));
        };
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const socket = net.connect(SERVICE_PORT, "127.0.0.1");
          socket.setTimeout(5000);
          let reply = "";
          socket.on("connect", () => socket.write(`${body.trim()}\n`));
          socket.on("data", (chunk) => {
            reply += chunk;
            const line = reply.split("\n")[0];
            if (reply.includes("\n")) {
              socket.end();
              res.setHeader("content-type", "application/json");
              res.end(line);
            }
          });
          socket.on("timeout", () => { socket.destroy(); fail("служба не ответила за 5 с"); });
          socket.on("error", (e) => fail(`служба недоступна: ${e.message}`));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceBridge()],
  // Именно 127.0.0.1, а не localhost: на Windows localhost резолвится сначала
  // в ::1, и Tauri стучится не туда, где слушает vite.
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
