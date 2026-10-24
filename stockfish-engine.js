const initStockfish = require("stockfish");

let engine;
let readyPromise;
let pendingSearch = null;
let initialized = false;

function start() {
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Stockfish initialization timed out"));
    }, 20000);

    engine = initStockfish("stockfish-19-lite.js", message => {
      const line = String(message).trim();

      if (line.includes("uciok") && !initialized) {
        initialized = true;
        engine.processCommand("isready");
      } else if (line.includes("readyok")) {
        clearTimeout(timer);
        resolve();
      } else if (line.startsWith("bestmove ") && pendingSearch) {
        const search = pendingSearch;
        pendingSearch = null;
        clearTimeout(search.timer);

        const match = line.match(/^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
        if (match) search.resolve(match[1]);
        else search.reject(new Error("Stockfish returned no legal move"));
      }
    });

    engine.processCommand("uci");
  });

  return readyPromise;
}

let queue = Promise.resolve();

function bestMove(fen, skill, depth) {
  const task = queue.then(async () => {
    await start();

    return new Promise((resolve, reject) => {
      if (pendingSearch) {
        reject(new Error("Stockfish is already searching"));
        return;
      }

      pendingSearch = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (pendingSearch?.resolve === resolve) {
            pendingSearch = null;
            reject(new Error("Stockfish search timed out"));
          }
        }, 30000)
      };

      engine.processCommand(`setoption name Skill Level value ${skill}`);
      engine.processCommand(`position fen ${fen}`);
      engine.processCommand(`go depth ${depth}`);
    });
  });

  queue = task.catch(() => {});
  return task;
}

module.exports = { bestMove };
