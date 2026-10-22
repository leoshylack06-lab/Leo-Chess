const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const crypto = require("node:crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

app.use(express.static("public"));

function makeCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function status(room) {
  const game = room.game;

  if (game.isCheckmate()) {
    return `Checkmate! ${game.turn() === "w" ? "Black" : "White"} wins.`;
  }
  if (game.isDraw()) return "Game drawn.";
  if (game.isCheck()) return "Check!";
  return `${game.turn() === "w" ? "White" : "Black"} to move`;
}

function sendState(code) {
  const room = rooms.get(code);
  if (!room) return;

  for (const color of ["w", "b"]) {
    const id = room.players[color];
    if (!id) continue;

    io.to(id).emit("state", {
      code,
      color,
      fen: room.game.fen(),
      pgn: room.game.pgn(),
      status: status(room),
      players: {
        white: Boolean(room.players.w),
        black: Boolean(room.players.b)
      }
    });
  }
}

io.on("connection", (socket) => {
  socket.on("createRoom", (callback) => {
    const code = makeCode();
    const room = {
      game: new Chess(),
      players: { w: socket.id, b: null }
    };

    rooms.set(code, room);
    socket.join(code);
    callback({ ok: true, code });
    sendState(code);
  });

  socket.on("joinRoom", (rawCode, callback) => {
    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      return callback({ ok: false, error: "Room not found." });
    }

    if (room.game.isGameOver()) {
      return callback({ ok: false, error: "This game has ended." });
    }

    let color;
    if (!room.players.w) color = "w";
    else if (!room.players.b) color = "b";
    else {
      return callback({ ok: false, error: "Room is full." });
    }

    room.players[color] = socket.id;
    socket.join(code);
    callback({ ok: true, code });
    sendState(code);
  });

  socket.on("makeMove", (data, callback) => {
    const code = String(data?.code || "").toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      return callback({ ok: false, error: "Room not found." });
    }

    const color = room.players.w === socket.id ? "w"
      : room.players.b === socket.id ? "b" : null;

    if (!color) {
      return callback({ ok: false, error: "You are not a player in this room." });
    }

    if (room.game.isGameOver()) {
      return callback({ ok: false, error: "The game has ended." });
    }

    if (room.game.turn() !== color) {
      return callback({ ok: false, error: "Wait for your turn." });
    }

    try {
      room.game.move({
        from: data.from,
        to: data.to,
        promotion: data.promotion || "q"
      });
      callback({ ok: true });
      sendState(code);
    } catch {
      callback({ ok: false, error: "Illegal move. Try again." });
    }
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      for (const color of ["w", "b"]) {
        if (room.players[color] === socket.id) {
          room.players[color] = null;
          sendState(code);
        }
      }

      if (!room.players.w && !room.players.b) {
        rooms.delete(code);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Leo Chess running on port ${PORT}`);
  console.log("Open http://127.0.0.1:3000 on your phone");
});
