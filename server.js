"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 10000);const INDEX = path.join(__dirname, "public", "public", "public", "public", "index.html", "l");
const ROUND_MS = 15000;
let room = null;

const questions = [
  {
    topic: "Gráfica",
    title: "El equipo se atasca con tareas exigentes.",
    prompt: "Quieren jugar a títulos potentes y editar en 3D. Según la presentación, ¿qué tarjeta ofrece más rendimiento gráfico y tiene VRAM propia?",
    options: ["Tarjeta gráfica integrada", "Tarjeta gráfica dedicada", "Tarjeta de captura de vídeo", "Tarjeta de red"],
    answer: 1,
    explanation: "La dedicada tiene su propia VRAM y mayor rendimiento gráfico; la presentación la destina a juegos potentes y edición 3D."
  },
  {
    topic: "Red",
    title: "El PC no puede comunicarse con la red.",
    prompt: "Hace falta el componente que transmite y recibe información y sirve de intermediario entre el ordenador y la red. ¿Cuál es?",
    options: ["Tarjeta de almacenamiento", "Tarjeta gráfica", "Tarjeta de red", "Tarjeta capturadora"],
    answer: 2,
    explanation: "La tarjeta de red conecta el ordenador con una red y gestiona el envío y la recepción de información."
  },
  {
    topic: "Almacenamiento",
    title: "El ordenador necesita más capacidad.",
    prompt: "Hay que ampliar el almacenamiento y conectar varios discos. ¿Qué tipo de tarjeta de expansión encaja con ese trabajo?",
    options: ["Tarjeta de puertos adicionales", "Tarjeta de almacenamiento", "Tarjeta de red", "Tarjeta gráfica"],
    answer: 1,
    explanation: "La presentación explica que la tarjeta de almacenamiento amplía la capacidad y puede servir para equipos con muchos discos o servidores."
  },
  {
    topic: "Captura de vídeo",
    title: "Quieren ver la consola en el PC.",
    prompt: "Conectan una PS5 por HDMI; la señal se procesa y OBS la reconoce como vídeo para verla en tiempo real. ¿Qué pieza falta?",
    options: ["Tarjeta de sonido", "Tarjeta de red", "Tarjeta capturadora de vídeo", "Tarjeta gráfica integrada"],
    answer: 2,
    explanation: "La capturadora recibe la señal por HDMI, procesa audio y vídeo y los envía al PC para que OBS los muestre."
  },
  {
    topic: "Puertos adicionales",
    title: "Se han quedado sin puertos USB.",
    prompt: "El ordenador tiene pocos USB y quieren conectar más dispositivos. ¿Qué solución aparece en la presentación?",
    options: ["Tarjeta PCIe de USB", "Tarjeta gráfica dedicada", "Tarjeta capturadora de vídeo", "Tarjeta de almacenamiento M.2 NVMe"],
    answer: 0,
    explanation: "Una tarjeta PCIe de USB añade puertos USB y permite conectar más dispositivos al ordenador."
  }
];

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise(function(resolve, reject) {
    let text = "";
    req.on("data", function(chunk) {
      text += chunk.toString("utf8");
      if (text.length > 12000) {
        reject(new Error("La solicitud es demasiado grande."));
        req.destroy();
      }
    });
    req.on("end", function() {
      try { resolve(text ? JSON.parse(text) : {}); }
      catch (_) { reject(new Error("Formato de solicitud no válido.")); }
    });
    req.on("error", reject);
  });
}

function closeRoundIfNeeded() {
  if (room && room.phase === "playing" && Date.now() >= room.deadline) room.phase = "review";
}

function hostRoom(data) {
  return room && room.code === String(data.code || "") && room.hostKey === data.key;
}

function playersSorted() {
  const qIndex = room.questionIndex;
  return Array.from(room.players.values()).map(function(p) {
    const answer = qIndex >= 0 ? p.answers[qIndex] : null;
    return {
      id: p.id,
      name: p.name,
      score: p.score,
      answered: answer !== null && answer !== undefined,
      choice: room.phase === "review" || room.phase === "done" ? answer : null,
      roundPoints: qIndex >= 0 ? (p.roundPoints[qIndex] || 0) : 0
    };
  }).sort(function(a, b) {
    return b.score - a.score || a.name.localeCompare(b.name, "es");
  }).map(function(p, i) {
    p.rank = i + 1;
    return p;
  });
}

function getState(role, playerId) {
  closeRoundIfNeeded();
  const players = playersSorted();
  const player = role === "player" ? room.players.get(playerId) : null;
  const sourceQuestion = room.questionIndex >= 0 ? questions[room.questionIndex] : null;
  const reveal = room.phase === "review" || room.phase === "done";
  const question = sourceQuestion ? {
    topic: sourceQuestion.topic,
    title: sourceQuestion.title,
    prompt: sourceQuestion.prompt,
    options: sourceQuestion.options,
    answer: reveal ? sourceQuestion.answer : null,
    explanation: reveal ? sourceQuestion.explanation : null
  } : null;
  return {
    code: room.code,
    phase: room.phase,
    questionIndex: room.questionIndex,
    questionTotal: questions.length,
    deadline: room.phase === "playing" ? room.deadline : null,
    question: question,
    players: players,
    playerCount: players.length,
    answeredCount: players.filter(function(p) { return p.answered; }).length,
    myAnswer: player && room.questionIndex >= 0 ? (player.answers[room.questionIndex] === undefined ? null : player.answers[room.questionIndex]) : null,
    myRoundPoints: player && room.questionIndex >= 0 ? (player.roundPoints[room.questionIndex] || 0) : 0,
    myRank: player ? players.findIndex(function(p) { return p.id === player.id; }) + 1 : null
  };
}

function startQuestion(index) {
  room.questionIndex = index;
  room.phase = "playing";
  room.deadline = Date.now() + ROUND_MS;
}

const server = http.createServer(async function(req, res) {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const route = url.pathname;

  if (req.method === "GET" && route === "/health") return json(res, 200, { ok: true });

  if (req.method === "GET" && (route === "/" || route === "/index.html")) {
    return fs.readFile(INDEX, function(err, data) {
      if (err) return json(res, 500, { error: "No encuentro la página del juego." });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      });
      res.end(data);
    });
  }

  if (req.method === "POST" && route === "/api/host") {
    let code;
    do { code = String(crypto.randomInt(100000, 1000000)); }
    while (room && room.code === code);
    const hostKey = crypto.randomBytes(24).toString("hex");
    room = {
      code: code,
      hostKey: hostKey,
      phase: "lobby",
      questionIndex: -1,
      deadline: 0,
      players: new Map()
    };
    return json(res, 201, { code: code, key: hostKey });
  }

  if (req.method === "POST" && route === "/api/join") {
    let data;
    try { data = await body(req); } catch (err) { return json(res, 400, { error: err.message }); }
    if (!room || String(data.code || "").replace(/\D/g, "") !== room.code) {
      return json(res, 404, { error: "No encuentro esa sala. Comprueba el código." });
    }
    if (room.phase !== "lobby") return json(res, 409, { error: "La partida ya empezó. Pide una sala nueva." });
    const name = String(data.name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 18);
    if (!name) return json(res, 400, { error: "Escribe un nombre para jugar." });
    const duplicate = Array.from(room.players.values()).some(function(p) {
      return p.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es");
    });
    if (duplicate) return json(res, 409, { error: "Ese nombre ya está en la sala. Prueba con otro." });
    const id = crypto.randomBytes(16).toString("hex");
    room.players.set(id, { id: id, name: name, score: 0, answers: [], roundPoints: [] });
    return json(res, 201, { code: room.code, playerId: id, name: name });
  }

  if (req.method === "GET" && route === "/api/state") {
    closeRoundIfNeeded();
    if (!room || url.searchParams.get("code") !== room.code) return json(res, 404, { error: "La sala ya no está disponible." });
    const role = url.searchParams.get("role");
    if (role === "host" && url.searchParams.get("key") === room.hostKey) return json(res, 200, getState("host", null));
    if (role === "player") {
      const id = url.searchParams.get("playerId");
      if (room.players.has(id)) return json(res, 200, getState("player", id));
    }
    return json(res, 403, { error: "Esta sesión ya no es válida." });
  }

  if (req.method === "POST" && route === "/api/start") {
    let data;
    try { data = await body(req); } catch (err) { return json(res, 400, { error: err.message }); }
    if (!hostRoom(data)) return json(res, 403, { error: "No se pudo validar la sala." });
    if (room.phase !== "lobby" || room.players.size === 0) return json(res, 409, { error: "Espera a que se una alguien antes de empezar." });
    startQuestion(0);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && route === "/api/answer") {
    let data;
    try { data = await body(req); } catch (err) { return json(res, 400, { error: err.message }); }
    closeRoundIfNeeded();
    if (!room || room.code !== String(data.code || "") || room.phase !== "playing") return json(res, 409, { error: "Esta ronda ya se ha cerrado." });
    const player = room.players.get(String(data.playerId || ""));
    if (!player) return json(res, 403, { error: "No encuentro a este jugador en la sala." });
    const choice = Number(data.choice);
    const question = questions[room.questionIndex];
    if (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length) return json(res, 400, { error: "Elige una respuesta válida." });
    if (player.answers[room.questionIndex] !== undefined) return json(res, 409, { error: "Ya has respondido." });
    player.answers[room.questionIndex] = choice;
    const points = choice === question.answer ? 500 + Math.round(500 * Math.max(0, room.deadline - Date.now()) / ROUND_MS) : 0;
    player.roundPoints[room.questionIndex] = points;
    player.score += points;
    return json(res, 200, { ok: true, points: points });
  }

  if (req.method === "POST" && route === "/api/next") {
    let data;
    try { data = await body(req); } catch (err) { return json(res, 400, { error: err.message }); }
    closeRoundIfNeeded();
    if (!hostRoom(data)) return json(res, 403, { error: "No se pudo validar la sala." });
    if (room.phase !== "review") return json(res, 409, { error: "Espera a que termine la ronda." });
    if (room.questionIndex + 1 >= questions.length) {
      room.phase = "done";
      return json(res, 200, { ok: true, done: true });
    }
    startQuestion(room.questionIndex + 1);
    return json(res, 200, { ok: true, done: false });
  }

  return json(res, 404, { error: "No se encontró la página." });
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("Juego en marcha en el puerto " + PORT + ".");
});
