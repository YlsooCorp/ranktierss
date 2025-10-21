require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const bcrypt = require("bcrypt");
const { WebhookClient, EmbedBuilder } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -------------------- FILE UPLOAD --------------------
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "-")),
});
const upload = multer({ storage });

// -------------------- EXPRESS CONFIG --------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret",
    resave: false,
    saveUninitialized: true,
  })
);

const TIERS = ["LT5","HT5","LT4","HT4","LT3","HT3","LT2","HT2","LT1","HT1"];

// -------------------- DISCORD WEBHOOK --------------------
const webhook = process.env.DISCORD_WEBHOOK_URL
  ? new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL })
  : null;

async function sendDiscordTierUpdate({ username, game, kit, tier, updated }) {
  if (!webhook) return;
  try {
    const embed = new EmbedBuilder()
      .setTitle(updated ? "🔁 Tier Updated" : "🌟 New Tier Earned!")
      .setDescription(
        `**${username}** has ${updated ? "updated" : "earned"} a tier in **${game}**!\n\n🎮 **Kit:** ${kit}\n🏅 **Tier:** ${tier}`
      )
      .setColor(updated ? 0xf1c40f : 0x2ecc71)
      .setTimestamp();
    await webhook.send({ embeds: [embed] });
  } catch (err) {
    console.error("Error sending Discord webhook:", err);
  }
}

// -------------------- UTILITY FUNCTIONS --------------------
async function getMinecraftUUID(username) {
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.id;
  } catch (err) {
    console.error("Error fetching Minecraft UUID:", err);
    return null;
  }
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect("/admin/login");
  next();
}

// -------------------- ACHIEVEMENTS --------------------
async function checkAndAwardAchievements(playerId, totalPoints, tier) {
  const { data: achievements } = await supabase.from("achievements").select("*");
  if (!achievements) return;

  for (const ach of achievements) {
    let qualifies = false;
    if (ach.condition_type === "points" && totalPoints >= ach.condition_value) qualifies = true;
    if (ach.condition_type === "tier" && tier === ach.condition_value) qualifies = true;

    if (qualifies) {
      const { data: existing } = await supabase
        .from("player_achievements")
        .select("*")
        .eq("player_id", playerId)
        .eq("achievement_id", ach.id)
        .maybeSingle();

      if (!existing)
        await supabase.from("player_achievements").insert([{ player_id: playerId, achievement_id: ach.id }]);
    }
  }
}

// -------------------- AUTH --------------------
app.get("/register", (_, res) => res.render("register", { error: null }));
app.post("/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.render("register", { error: "Email and password required" });

  const { data: existing } = await supabase.from("users").select("*").eq("email", email).single();
  if (existing) return res.render("register", { error: "Email already registered" });

  const password_hash = await bcrypt.hash(password, 10);
  await supabase.from("users").insert([{ email, password_hash }]);
  res.redirect("/login");
});

app.get("/login", (_, res) => res.render("login", { error: null }));
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.render("login", { error: "Email and password required" });

  const { data: user } = await supabase.from("users").select("*").eq("email", email).single();
  if (!user) return res.render("login", { error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.render("login", { error: "Invalid credentials" });

  req.session.user = { id: user.id, email: user.email };
  res.redirect("/account");
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// -------------------- ACCOUNT LINKING --------------------
app.get("/account", requireAuth, async (req, res) => {
  const { data: linked } = await supabase
    .from("user_linked_accounts")
    .select("*")
    .eq("user_id", req.session.user.id);

  const { data: games } = await supabase.from("games").select("*").order("name");
  res.render("account", { linked: linked || [], games: games || [], user: req.session.user });
});

app.post("/account/link", requireAuth, async (req, res) => {
  const { game, game_username, game_id } = req.body;
  if (!game || !game_username) return res.redirect("/account");

  if (game === "Clash Royale" && !game_id) {
    return res.render("account", {
      linked: [],
      games: [],
      user: req.session.user,
      error: "Clash Royale ID is required.",
    });
  }

  const { data: existing } = await supabase
    .from("user_linked_accounts")
    .select("*")
    .eq("user_id", req.session.user.id)
    .eq("game", game)
    .single();

  if (existing)
    await supabase
      .from("user_linked_accounts")
      .update({ game_username, game_id })
      .eq("id", existing.id);
  else
    await supabase.from("user_linked_accounts").insert([
      {
        user_id: req.session.user.id,
        game,
        game_username,
        game_id: game === "Clash Royale" ? game_id : null,
      },
    ]);

  res.redirect("/account");
});

// -------------------- ADMIN --------------------
app.get("/admin/login", (_, res) => res.render("admin-login", { error: null }));
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.admin = { username };
    return res.redirect("/admin/dashboard");
  }
  res.render("admin-login", { error: "Invalid credentials" });
});
app.get("/admin/logout", (req, res) => {
  req.session.admin = null;
  res.redirect("/admin/login");
});

app.get("/admin/overview", requireAdmin, async (req, res) => { // <-- CHANGED from /admin/dashboard
  const { data: games } = await supabase.from("games").select("*");
  const { data: players } = await supabase.from("players").select("*");
  const { data: submissions } = await supabase.from("submissions").select("*").order("created_at", { ascending: true });
  res.render("admin-dashboard", { games, players, submissions, stats: [], TIERS }); // <-- ADDED stats: [], TIERS
});

app.post("/admin/game/add", requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.redirect("/admin/dashboard");
  await supabase.from("games").insert([{ name }]);
  res.redirect("/admin/dashboard");
});

// -------------------- MAIN PAGES --------------------
app.get("/", async (req, res) => {
  const { data: games } = await supabase.from("games").select("*").order("name");
  let linkedAccounts = [];
  if (req.session.user) {
    const { data } = await supabase
      .from("user_linked_accounts")
      .select("*")
      .eq("user_id", req.session.user.id);
    linkedAccounts = data || [];
  }

  res.render("index", { games: games || [], user: req.session.user || null, linkedAccounts });
});

app.get("/game/:name", async (req, res) => {
  const { name } = req.params;
  const { data: allStats } = await supabase
    .from("player_stats")
    .select("player_id, kit, tier, points, players(username)")
    .eq("game", name);

  if (!allStats || allStats.length === 0)
    return res.render("game", { stats: [], gameName: name, userLinked: [], user: req.session.user || null });

  const map = {};
  allStats.forEach(stat => {
    const pid = stat.player_id;
    if (!map[pid]) map[pid] = { players: stat.players, total_points: 0, kits: [] };
    map[pid].total_points += stat.points;
    map[pid].kits.push({ kit: stat.kit, tier: stat.tier });
  });
  const stats = Object.values(map).sort((a, b) => b.total_points - a.total_points);

  let userLinked = [];
  if (req.session.user) {
    const { data } = await supabase
      .from("user_linked_accounts")
      .select("*")
      .eq("user_id", req.session.user.id)
      .eq("game", name);
    userLinked = data || [];
  }

  res.render("game", { stats, gameName: name, userLinked, user: req.session.user || null });
});

// -------------------- PROFILE --------------------
app.get("/profile/:username", async (req, res) => {
  const { username } = req.params;
  const { data: player } = await supabase.from("players").select("*").eq("username", username).single();
  if (!player) return res.status(404).send("Player not found");

  const { data: stats } = await supabase
    .from("player_stats")
    .select("game, kit, tier, points")
    .eq("player_id", player.id)
    .order("points", { ascending: false });

  const { data: achievements } = await supabase
    .from("player_achievements")
    .select("earned_at, achievements(name, description, icon)")
    .eq("player_id", player.id);

  const hasMinecraft = stats.some(s => s.game.toLowerCase() === "minecraft");
  let mcUUID = null;
  if (hasMinecraft) mcUUID = await getMinecraftUUID(username);

  const totalPoints = stats.reduce((a, s) => a + s.points, 0);
  res.render("profile", {
    player,
    stats: stats || [],
    achievements: achievements || [],
    mcUUID,
    user: req.session.user || null,
    totalPoints
  });
});

// -------------------- ADVANCED ADMIN MANAGEMENT --------------------

// Add a new player manually
app.post("/admin/player/add", requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.redirect("/admin/dashboard");
  await supabase.from("players").insert([{ username }]);
  res.redirect("/admin/dashboard");
});

// Edit a player's tier or points (and trigger Discord notification)
app.post("/admin/stat/update/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { tier, points } = req.body;

  const { data: stat } = await supabase
    .from("player_stats")
    .select("id, player_id, kit, tier, points, game, players(username)")
    .eq("id", id)
    .single();

  if (!stat) return res.redirect("/admin/dashboard");

  const updatedTier = tier || stat.tier;
  const updatedPoints = parseInt(points) || stat.points;

  await supabase
    .from("player_stats")
    .update({ tier: updatedTier, points: updatedPoints })
    .eq("id", id);

  // ✅ Send webhook notification
  await sendDiscordTierUpdate({
    username: stat.players.username,
    game: stat.game,
    kit: stat.kit,
    tier: updatedTier,
    updated: true,
  });

  res.redirect("/admin/dashboard");
});

// Delete record (player, game, or stat)
app.post("/admin/delete/:table/:id", requireAdmin, async (req, res) => {
  const { table, id } = req.params;
  const validTables = ["games", "players", "player_stats"];
  if (!validTables.includes(table)) return res.redirect("/admin/dashboard");
  await supabase.from(table).delete().eq("id", id);
  res.redirect("/admin/dashboard");
});

// Enhanced Admin Dashboard with management tables
app.get("/admin/dashboard", requireAdmin, async (req, res) => {
  const { data: games } = await supabase.from("games").select("*").order("name");
  const { data: players } = await supabase.from("players").select("*").order("username");
  const { data: stats } = await supabase
    .from("player_stats")
    .select("id, player_id, game, kit, tier, points, players(username)")
    .order("points", { ascending: false });

  res.render("admin-dashboard", {
    admin: req.session.admin,
    games: games || [],
    players: players || [],
    stats: stats || [],
    TIERS,
  });
});


// -------------------- COMPARE --------------------
app.get("/compare", async (req, res) => {
  const { player1, player2 } = req.query;
  if (!player1 || !player2) return res.render("compare", { error: "Please enter both players." });

  const { data: p1 } = await supabase.from("players").select("*").eq("username", player1).single();
  const { data: p2 } = await supabase.from("players").select("*").eq("username", player2).single();
  if (!p1 || !p2) return res.render("compare", { error: "Player not found." });

  const { data: s1 } = await supabase.from("player_stats").select("*").eq("player_id", p1.id);
  const { data: s2 } = await supabase.from("player_stats").select("*").eq("player_id", p2.id);

  const total1 = s1.reduce((a, s) => a + s.points, 0);
  const total2 = s2.reduce((a, s) => a + s.points, 0);

  const totalGames1 = s1.length;
  const totalGames2 = s2.length;

  const avg1 = totalGames1 > 0 ? (total1 / totalGames1).toFixed(1) : 0;
  const avg2 = totalGames2 > 0 ? (total2 / totalGames2).toFixed(1) : 0;

  const winRate1 = (total1 + total2) > 0 ? ((total1 / (total1 + total2)) * 100).toFixed(1) : 0;
  const winRate2 = (total1 + total2) > 0 ? ((total2 / (total1 + total2)) * 100).toFixed(1) : 0;

  const kits1 = [...new Set(s1.map(s => `${s.kit} (${s.tier})`))];
  const kits2 = [...new Set(s2.map(s => `${s.kit} (${s.tier})`))];

  res.render("compare", {
    player1: p1,
    player2: p2,
    total1,
    total2,
    totalGames1,
    totalGames2,
    avg1,
    avg2,
    winRate1,
    winRate2,
    kits1,
    kits2,
    user: req.session.user || null,
    error: null,
  });
});

// -------------------- SUBMIT --------------------
app.get("/submit", (_, res) => res.render("submit", { error: null, success: null }));

app.post("/submit", upload.single("screenshot"), async (req, res) => {
  try {
    const { player_name, game, kit, tier, points } = req.body;
    const screenshot = req.file ? req.file.filename : null;

    if (!TIERS.includes(tier)) {
      return res.render("submit", { error: "Invalid tier selected", success: null });
    }

    let { data: player } = await supabase
      .from("players")
      .select("*")
      .eq("username", player_name)
      .limit(1);

    if (!player || player.length === 0) {
      const { data: created } = await supabase
        .from("players")
        .insert([{ username: player_name }])
        .select()
        .single();
      player = created;
    } else {
      player = player[0];
    }

    const { data: existing } = await supabase
      .from("player_stats")
      .select("*")
      .eq("player_id", player.id)
      .eq("game", game)
      .eq("kit", kit)
      .maybeSingle();

    let updated = false;
    if (existing) {
      await supabase
        .from("player_stats")
        .update({ tier, points: parseInt(points) || existing.points })
        .eq("id", existing.id);
      updated = true;
    } else {
      await supabase.from("player_stats").insert([
        {
          player_id: player.id,
          game,
          kit,
          tier,
          points: parseInt(points) || 0,
        },
      ]);
    }

    await supabase.from("submissions").insert([
      {
        player_id: player.id,
        player_name,
        game,
        kit,
        tier,
        points: parseInt(points) || 0,
        screenshot,
      },
    ]);

    await checkAndAwardAchievements(player.id, parseInt(points) || 0, tier);

    // ✅ Send Discord notification
    await sendDiscordTierUpdate({
      username: player.username,
      game,
      kit,
      tier,
      updated,
    });

    res.render("submit", {
      success: updated
        ? "Tier updated successfully and notification sent!"
        : "Submission received. Awaiting admin review.",
      error: null,
    });
  } catch (err) {
    console.error(err);
    res.render("submit", { error: "Submission failed.", success: null });
  }
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`🚀 RankTiers running at http://localhost:${PORT}`));
