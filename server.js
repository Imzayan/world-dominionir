const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("DATABASE_URL is missing. Create a PostgreSQL database and set DATABASE_URL.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const sql = async (text, params=[]) => (await pool.query(text, params)).rows;

async function initDb() {
  if (!DATABASE_URL) return;
  await pool.query(require("fs").readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
}

function sign(player) {
  return jwt.sign({ id: player.id, username: player.username }, JWT_SECRET, { expiresIn: "30d" });
}

async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "وارد حساب نشده‌اید." });
    const decoded = jwt.verify(token, JWT_SECRET);
    const rows = await sql("SELECT id, email, username, country_code, gold, food, oil, army, level, xp FROM players WHERE id=$1", [decoded.id]);
    if (!rows[0]) return res.status(401).json({ error: "حساب پیدا نشد." });
    req.player = rows[0];
    await sql("UPDATE players SET last_active=NOW() WHERE id=$1", [req.player.id]);
    next();
  } catch {
    res.status(401).json({ error: "نشست نامعتبر است." });
  }
}

function cleanText(s, max=80) {
  return String(s ?? "").trim().replace(/[<>]/g, "").slice(0, max);
}

app.post("/api/register", async (req,res) => {
  try {
    const email = cleanText(req.body.email, 120).toLowerCase();
    const username = cleanText(req.body.username, 24);
    const password = String(req.body.password || "");
    if (!email.includes("@") || username.length < 3 || password.length < 6) {
      return res.status(400).json({error:"ایمیل، نام کاربری و رمز عبور را درست وارد کن."});
    }
    const exists = await sql("SELECT id FROM players WHERE email=$1 OR username=$2", [email, username]);
    if (exists[0]) return res.status(409).json({error:"ایمیل یا نام کاربری قبلاً ثبت شده است."});
    const hash = await bcrypt.hash(password, 12);
    const rows = await sql(
      "INSERT INTO players(email,password_hash,username) VALUES($1,$2,$3) RETURNING id,email,username,country_code,gold,food,oil,army,level,xp",
      [email,hash,username]
    );
    const player = rows[0];
    res.json({token:sign(player), player});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:"خطای سرور."});
  }
});

app.post("/api/login", async (req,res) => {
  try {
    const email = cleanText(req.body.email,120).toLowerCase();
    const password = String(req.body.password || "");
    const rows = await sql("SELECT * FROM players WHERE email=$1", [email]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({error:"ایمیل یا رمز عبور اشتباه است."});
    }
    const p = rows[0];
    await sql("UPDATE players SET last_active=NOW() WHERE id=$1", [p.id]);
    res.json({
      token:sign(p),
      player:{id:p.id,email:p.email,username:p.username,country_code:p.country_code,gold:p.gold,food:p.food,oil:p.oil,army:p.army,level:p.level,xp:p.xp}
    });
  } catch(e) { console.error(e); res.status(500).json({error:"خطای سرور."}); }
});

app.post("/api/countries/sync", auth, async (req,res) => {
  try {
    const list = Array.isArray(req.body.countries) ? req.body.countries.slice(0,300) : [];
    for (const c of list) {
      const code = cleanText(c.code,12);
      const name = cleanText(c.name,80);
      if (!code || !name) continue;
      await sql(
        `INSERT INTO countries(code,name) VALUES($1,$2)
         ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name`,
        [code,name]
      );
    }
    res.json({ok:true});
  } catch(e) { console.error(e); res.status(500).json({error:"خطا در همگام‌سازی نقشه."}); }
});

app.get("/api/state", auth, async (req,res) => {
  try {
    const countries = await sql(`
      SELECT c.code,c.name,c.owner_id,c.power,c.population,
             p.username AS owner_username
      FROM countries c LEFT JOIN players p ON p.id=c.owner_id
      ORDER BY c.name
    `);
    const alliance = await sql(`
      SELECT a.id,a.name,a.tag,a.leader_id
      FROM alliances a JOIN alliance_members am ON am.alliance_id=a.id
      WHERE am.player_id=$1
    `,[req.player.id]);
    const chat = await sql(`
      SELECT id,username,message,created_at
      FROM chat_messages ORDER BY id DESC LIMIT 50
    `);
    const online = await sql(`SELECT COUNT(*)::int AS n FROM players WHERE last_active > NOW() - INTERVAL '90 seconds'`);
    res.json({player:req.player,countries,alliance:alliance[0]||null,chat:chat.reverse(),online:online[0].n});
  } catch(e) { console.error(e); res.status(500).json({error:"خطا در دریافت وضعیت بازی."}); }
});

app.post("/api/choose-country", auth, async (req,res) => {
  const code = cleanText(req.body.code,12);
  try {
    const client = await pool.connect();
    await client.query("BEGIN");
    const c = (await client.query("SELECT * FROM countries WHERE code=$1 FOR UPDATE",[code])).rows[0];
    if (!c) { await client.query("ROLLBACK"); client.release(); return res.status(404).json({error:"کشور پیدا نشد."}); }
    if (c.owner_id && c.owner_id !== req.player.id) {
      await client.query("ROLLBACK"); client.release(); return res.status(409).json({error:"این کشور قبلاً گرفته شده است."});
    }
    await client.query("UPDATE countries SET owner_id=$1,updated_at=NOW() WHERE code=$2",[req.player.id,code]);
    await client.query("UPDATE players SET country_code=$1,last_active=NOW() WHERE id=$2",[code,req.player.id]);
    await client.query("COMMIT");
    client.release();
    io.emit("state:changed",{type:"country"});
    res.json({ok:true});
  } catch(e) { try{await client.query("ROLLBACK")}catch{}; try{client.release()}catch{}; console.error(e); res.status(500).json({error:"خطا در انتخاب کشور."}); }
});

app.post("/api/attack", auth, async (req,res) => {
  const code = cleanText(req.body.code,12);
  const soldiers = Math.max(100, Math.floor(Number(req.body.soldiers)||0));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const me = (await client.query("SELECT * FROM players WHERE id=$1 FOR UPDATE",[req.player.id])).rows[0];
    const c = (await client.query("SELECT * FROM countries WHERE code=$1 FOR UPDATE",[code])).rows[0];
    if (!c) throw Object.assign(new Error("کشور پیدا نشد."),{status:404});
    if (c.owner_id === me.id) throw Object.assign(new Error("نمی‌توانی به کشور خودت حمله کنی."),{status:400});
    if (soldiers > me.army) throw Object.assign(new Error("ارتش کافی نداری."),{status:400});
    const defenderArmy = Math.max(500, Math.floor(c.power));
    const attackScore = soldiers * (0.85 + Math.random()*0.3);
    const defendScore = defenderArmy * (0.85 + Math.random()*0.3);
    const win = attackScore > defendScore;
    const attackerLoss = Math.min(soldiers-1, Math.max(50, Math.floor(soldiers*(win ? 0.18 : 0.48))));
    const defenderLoss = Math.min(defenderArmy, Math.max(50, Math.floor(defenderArmy*(win ? 0.65 : 0.18))));
    const newArmy = me.army - attackerLoss;
    if (win) {
      await client.query("UPDATE countries SET owner_id=$1,power=$2,updated_at=NOW() WHERE code=$3",
        [me.id,Math.max(500,defenderArmy-defenderLoss+Math.floor(soldiers*0.35)),code]);
      await client.query("UPDATE players SET army=$1,gold=gold+500,food=GREATEST(0,food-500),last_active=NOW() WHERE id=$2",
        [newArmy,me.id]);
    } else {
      await client.query("UPDATE countries SET power=$1,updated_at=NOW() WHERE code=$2",
        [Math.max(500,defenderArmy-defenderLoss),code]);
      await client.query("UPDATE players SET army=$1,food=GREATEST(0,food-250),last_active=NOW() WHERE id=$2",
        [newArmy,me.id]);
    }
    await client.query(
      "INSERT INTO battles(attacker_id,defender_id,country_code,attacker_loss,defender_loss,result) VALUES($1,$2,$3,$4,$5,$6)",
      [me.id,c.owner_id,code,attackerLoss,defenderLoss,win?"victory":"defeat"]
    );
    await client.query("COMMIT");
    io.emit("battle:result",{country:code,result:win?"victory":"defeat"});
    io.emit("state:changed",{type:"battle"});
    res.json({ok:true,result:win?"victory":"defeat",attackerLoss,defenderLoss,newArmy});
  } catch(e) {
    try{await client.query("ROLLBACK")}catch{}
    res.status(e.status||500).json({error:e.message||"خطا در جنگ."});
  } finally { client.release(); }
});

app.post("/api/alliance/create", auth, async (req,res) => {
  const name=cleanText(req.body.name,30), tag=cleanText(req.body.tag,6).toUpperCase();
  if(name.length<3||tag.length<2) return res.status(400).json({error:"نام و تگ اتحاد را درست وارد کن."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const a=(await client.query("INSERT INTO alliances(name,tag,leader_id) VALUES($1,$2,$3) RETURNING id,name,tag,leader_id",[name,tag,req.player.id])).rows[0];
    await client.query("INSERT INTO alliance_members(alliance_id,player_id) VALUES($1,$2)",[a.id,req.player.id]);
    await client.query("COMMIT");
    io.emit("state:changed",{type:"alliance"});
    res.json({alliance:a});
  }catch(e){try{await client.query("ROLLBACK")}catch{};res.status(409).json({error:"این نام یا تگ اتحاد قبلاً استفاده شده است."})}
  finally{client.release()}
});

app.post("/api/alliance/join", auth, async (req,res) => {
  const id=Number(req.body.allianceId);
  try{
    const a=(await sql("SELECT * FROM alliances WHERE id=$1",[id]))[0];
    if(!a) return res.status(404).json({error:"اتحاد پیدا نشد."});
    await sql("INSERT INTO alliance_members(alliance_id,player_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,req.player.id]);
    io.emit("state:changed",{type:"alliance"});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"خطا در عضویت اتحاد."})}
});

app.post("/api/alliance/leave", auth, async (req,res) => {
  try{
    await sql("DELETE FROM alliance_members WHERE player_id=$1",[req.player.id]);
    io.emit("state:changed",{type:"alliance"});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"خطا."})}
});

app.get("/api/alliances", auth, async (req,res) => {
  const rows=await sql(`
    SELECT a.id,a.name,a.tag,a.leader_id,COUNT(am.player_id)::int AS members
    FROM alliances a LEFT JOIN alliance_members am ON am.alliance_id=a.id
    GROUP BY a.id ORDER BY members DESC,a.id LIMIT 50
  `);
  res.json({alliances:rows});
});

app.post("/api/chat", auth, async (req,res) => {
  const message=cleanText(req.body.message,180);
  if(!message) return res.status(400).json({error:"پیام خالی است."});
  const rows=await sql(
    "INSERT INTO chat_messages(player_id,username,message) VALUES($1,$2,$3) RETURNING id,username,message,created_at",
    [req.player.id,req.player.username,message]
  );
  io.emit("chat:new",rows[0]);
  res.json({message:rows[0]});
});

app.get("/api/leaderboard", auth, async (req,res) => {
  const rows=await sql(`
    SELECT username,level,army,gold,xp
    FROM players ORDER BY army DESC,gold DESC LIMIT 20
  `);
  res.json({players:rows});
});

io.use((socket,next)=>{
  try{
    const token=String(socket.handshake.auth?.token||"");
    socket.user=jwt.verify(token,JWT_SECRET);
    next();
  }catch{ next(new Error("unauthorized")); }
});

io.on("connection",async socket=>{
  await sql("UPDATE players SET last_active=NOW() WHERE id=$1",[socket.user.id]).catch(()=>{});
  socket.join("world");
  io.emit("online:ping");
  socket.on("presence",()=>sql("UPDATE players SET last_active=NOW() WHERE id=$1",[socket.user.id]).catch(()=>{}));
  socket.on("disconnect",()=>io.emit("online:ping"));
});

app.get("/health", async (req,res) => {
  try {
    if (!DATABASE_URL) return res.status(503).json({ok:false,error:"DATABASE_URL is not configured"});
    await pool.query("SELECT 1");
    res.json({ok:true,service:"world-dominion"});
  } catch (e) {
    res.status(503).json({ok:false,error:"database unavailable"});
  }
});

app.get("/{*splat}",(req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"Not found"});
  res.sendFile(path.join(__dirname,"public","index.html"));
});

initDb().then(()=>{
  server.listen(PORT,"0.0.0.0",()=>console.log(`World Dominion running on :${PORT}`));
}).catch(e=>{console.error("DB init failed",e);process.exit(1);});
