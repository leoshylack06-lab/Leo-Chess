const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const crypto = require("node:crypto");
const { bestMove } = require("./stockfish-engine");

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
      ply: room.game.history().length,
      lastMove: room.lastMove || null,
      status: status(room),
      players: {
        white: Boolean(room.players.w),
        black: Boolean(room.players.b)
      }
    });
  }
}


function sendAIState(socket) {
  const session = socket.data.aiGame;
  if (!session) return;

  const game = session.game;
  const status = game.isCheckmate()
    ? `Checkmate! ${game.turn() === "w" ? "Black" : "White"} wins.`
    : game.isDraw() ? "Game drawn."
    : game.isCheck() ? "Check!"
    : `${game.turn() === "w" ? "White" : "Black"} to move`;

  socket.emit("aiState", {
    fen: game.fen(),
    pgn: game.pgn(),
    ply: game.history().length,
    status: session.thinking ? "Stockfish is thinking..." : status,
    difficulty: session.difficulty,
    thinking: session.thinking,
    gameOver: game.isGameOver(),
    lastMove: session.lastMove
  });
}

io.on("connection", (socket) => {
  socket.on("startAI", (difficulty, callback) => {
    const levels = {
      easy: { skill: 0, depth: 2 },
      medium: { skill: 5, depth: 4 },
      hard: { skill: 10, depth: 6 },
      expert: { skill: 15, depth: 8 }
    };

    const level = levels[String(difficulty || "medium").toLowerCase()];
    if (!level) {
      if (typeof callback === "function") callback({ ok: false, error: "Invalid difficulty." });
      return;
    }

    socket.data.aiGame = {
      game: new Chess(),
      level,
      difficulty: String(difficulty || "medium").toLowerCase(),
      thinking: false,
      lastMove: null
    };

    if (typeof callback === "function") callback({ ok: true });
    sendAIState(socket);
  });

  socket.on("aiMove", async (data, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const session = socket.data.aiGame;

    if (!session) return reply({ ok: false, error: "Start an AI game first." });
    if (session.thinking) return reply({ ok: false, error: "AI is thinking." });
    if (session.game.isGameOver()) return reply({ ok: false, error: "Game over." });
    if (session.game.turn() !== "w") return reply({ ok: false, error: "Wait for the AI." });

    let move;
    try {
      move = session.game.move({
        from: data.from,
        to: data.to,
        promotion: data.promotion || "q"
      });
    } catch {
      return reply({ ok: false, error: "Illegal move." });
    }

    session.lastMove = {
      from: move.from, to: move.to,
      capture: Boolean(move.captured),
      check: session.game.isCheck(),
      mate: session.game.isCheckmate()
    };

    reply({ ok: true });
    sendAIState(socket);

    if (session.game.isGameOver()) return;

    session.thinking = true;
    sendAIState(socket);

    try {
      const uci = await bestMove(
        session.game.fen(),
        session.level.skill,
        session.level.depth
      );

      if (socket.data.aiGame !== session) return;

      const aiMove = session.game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || "q"
      });

      session.lastMove = {
        from: aiMove.from, to: aiMove.to,
        capture: Boolean(aiMove.captured),
        check: session.game.isCheck(),
        mate: session.game.isCheckmate()
      };
    } catch (error) {
      console.error("AI move failed:", error.message);
      socket.emit("aiError", "The AI could not move. Restart the game.");
    } finally {
      if (socket.data.aiGame === session) {
        session.thinking = false;
        sendAIState(socket);
      }
    }
  });

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
      const move = room.game.move({
        from: data.from,
        to: data.to,
        promotion: data.promotion || "q"
      });

      // LEO_CHESS_MOVE_FEEDBACK
      room.lastMove = {
        from: move.from,
        to: move.to,
        capture: Boolean(move.captured),
        check: room.game.isCheck(),
        mate: room.game.isCheckmate(),
        ply: room.game.history().length
      };

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
