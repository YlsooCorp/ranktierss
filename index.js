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

const TIERS = ["LT5", "HT5", "LT4", "HT4", "LT3", "HT3", "LT2", "HT2", "LT1", "HT1"];

function buildBracket(players) {
  const sanitized = players.filter(Boolean);
  if (sanitized.length === 0) return { rounds: [] };

  const bracketSize = Math.max(2, 1 << Math.ceil(Math.log2(sanitized.length)));
  const slots = [...sanitized];
  while (slots.length < bracketSize) slots.push(null);

  const rounds = [];
  let previousRound = [];

  const firstRound = [];
  for (let i = 0; i < slots.length; i += 2) {
    const matchId = `r1m${i / 2 + 1}`;
    firstRound.push({
      id: matchId,
      round: 1,
      match: i / 2 + 1,
      player1: slots[i],
      player2: slots[i + 1],
      winner: null,
      loser: null,
      autoAdvance: false,
      source1: null,
      source2: null,
      nextMatchId: null,
      nextMatchSlot: null,
    });
  }
  rounds.push(firstRound);
  previousRound = firstRound;

  let roundNumber = 2;
  while (previousRound.length > 1) {
    const currentRound = [];
    for (let i = 0; i < previousRound.length; i += 2) {
      const matchId = `r${roundNumber}m${i / 2 + 1}`;
      const match = {
        id: matchId,
        round: roundNumber,
        match: i / 2 + 1,
        player1: null,
        player2: null,
        winner: null,
        loser: null,
        autoAdvance: false,
        source1: previousRound[i]?.id || null,
        source2: previousRound[i + 1]?.id || null,
        nextMatchId: null,
        nextMatchSlot: null,
      };
      currentRound.push(match);
      if (previousRound[i]) {
        previousRound[i].nextMatchId = matchId;
        previousRound[i].nextMatchSlot = "player1";
      }
      if (previousRound[i + 1]) {
        previousRound[i + 1].nextMatchId = matchId;
        previousRound[i + 1].nextMatchSlot = "player2";
      }
    }
    rounds.push(currentRound);
    previousRound = currentRound;
    roundNumber++;
  }

  return { rounds };
}

function indexBracketMatches(bracket) {
  const map = new Map();
  if (!bracket || !Array.isArray(bracket.rounds)) return map;
  bracket.rounds.forEach(round => {
    round.forEach(match => {
      map.set(match.id, match);
    });
  });
  return map;
}

function propagateAutoAdvances(bracket) {
  const matchMap = indexBracketMatches(bracket);
  const queue = [];
  matchMap.forEach(match => {
    const onlyOne = (match.player1 && !match.player2) || (!match.player1 && match.player2);
    if (onlyOne && !match.winner) {
      match.autoAdvance = true;
      match.winner = match.player1 || match.player2;
      queue.push(match);
    }
  });

  while (queue.length > 0) {
    const match = queue.shift();
    if (!match.nextMatchId || !match.winner) continue;
    const next = matchMap.get(match.nextMatchId);
    if (!next) continue;
    next[match.nextMatchSlot] = match.winner;
    const onlyOne = (next.player1 && !next.player2) || (!next.player1 && next.player2);
    if (onlyOne && !next.winner) {
      next.autoAdvance = true;
      next.winner = next.player1 || next.player2;
      queue.push(next);
    }
  }
}

function assignWinnerToNextMatch(bracket, match) {
  if (!match.nextMatchId || !match.winner) return;
  const matchMap = indexBracketMatches(bracket);
  const next = matchMap.get(match.nextMatchId);
  if (!next) return;
  next[match.nextMatchSlot] = match.winner;
  const onlyOne = (next.player1 && !next.player2) || (!next.player1 && next.player2);
  if (onlyOne && !next.winner) {
    next.autoAdvance = true;
    next.winner = next.player1 || next.player2;
    assignWinnerToNextMatch(bracket, next);
  }
}

function findMatch(bracket, matchId) {
  if (!bracket || !Array.isArray(bracket.rounds)) return null;
  for (const round of bracket.rounds) {
    for (const match of round) {
      if (match.id === matchId) return match;
    }
  }
  return null;
}

app.get("/discord", (_, res) => {
  res.redirect("https://discord.gg/ranktiers");
});

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

app.get("/terms", (req, res) => {
  res.render("terms", { user: req.session.user || null });
});

app.get("/privacy", (req, res) => {
  res.render("privacy", { user: req.session.user || null });
});

app.get("/events", async (req, res) => {
  const { data: events } = await supabase
    .from("events")
    .select("id, name, game, kit, created_at")
    .order("created_at", { ascending: false });
  res.render("events", {
    events: events || [],
    user: req.session.user || null,
  });
});

app.get("/events/:id", async (req, res) => {
  const eventId = req.params.id;
  const { data: event } = await supabase.from("events").select("*").eq("id", eventId).maybeSingle();
  if (!event) return res.status(404).send("Event not found");

  const bracket = typeof event.bracket === "string" ? JSON.parse(event.bracket) : event.bracket || { rounds: [] };
  const { data: records } = await supabase
    .from("player_event_records")
    .select("player_id, wins, losses, players(username)")
    .eq("event_id", eventId);

  res.render("event", {
    event,
    bracket,
    adminView: false,
    records: records || [],
    adminMessage: null,
    adminError: null,
    user: req.session.user || null,
    admin: req.session.admin || null,
  });
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

  const { data: eventRecords } = await supabase
    .from("player_event_records")
    .select("event_id, wins, losses, events(name, game, kit)")
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
    totalPoints,
    eventRecords: eventRecords || [],
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

app.post("/admin/events/create", requireAdmin, async (req, res) => {
  const { name, game, kit, tiers_all, tiers } = req.body;
  if (!name || !game || !kit) {
    req.session.adminError = "Event name, game, and kit are required.";
    return res.redirect("/admin/dashboard");
  }

  let selectedTiers = [];
  if (tiers_all === "on") selectedTiers = [...TIERS];
  else if (Array.isArray(tiers)) selectedTiers = tiers;
  else if (typeof tiers === "string" && tiers.trim() !== "") selectedTiers = [tiers];

  if (selectedTiers.length === 0) selectedTiers = [...TIERS];

  try {
    let query = supabase
      .from("player_stats")
      .select("player_id, tier, players(username)")
      .eq("game", game)
      .eq("kit", kit);

    if (selectedTiers.length !== TIERS.length) {
      query = query.in("tier", selectedTiers);
    }

    const { data: stats, error: statsError } = await query;
    if (statsError) throw statsError;

    if (!stats || stats.length === 0) {
      req.session.adminError = "No players found for the selected criteria.";
      return res.redirect("/admin/dashboard");
    }

    const seen = new Set();
    const participants = [];
    stats.forEach(stat => {
      if (!seen.has(stat.player_id)) {
        seen.add(stat.player_id);
        participants.push({
          id: stat.player_id,
          username: stat.players?.username || `Player ${stat.player_id}`,
        });
      }
    });

    participants.sort(() => Math.random() - 0.5);

    if (participants.length < 2) {
      req.session.adminError = "At least two players are required to create an event.";
      return res.redirect("/admin/dashboard");
    }

    const bracket = buildBracket(participants);
    propagateAutoAdvances(bracket);

    const { data: createdEvent, error: eventError } = await supabase
      .from("events")
      .insert([
        {
          name,
          game,
          kit,
          tiers: selectedTiers,
          bracket,
        },
      ])
      .select()
      .single();

    if (eventError) throw eventError;

    await supabase.from("player_event_records").upsert(
      participants.map(participant => ({
        event_id: createdEvent.id,
        player_id: participant.id,
        wins: 0,
        losses: 0,
      })),
      { onConflict: "event_id,player_id" }
    );

    req.session.adminMessage = `Event "${name}" created successfully.`;
    res.redirect(`/admin/events/${createdEvent.id}`);
  } catch (error) {
    console.error("Failed to create event", error);
    req.session.adminError = "Failed to create event. Please try again.";
    res.redirect("/admin/dashboard");
  }
});

app.get("/admin/events/:id", requireAdmin, async (req, res) => {
  const eventId = req.params.id;
  const { data: event, error } = await supabase.from("events").select("*").eq("id", eventId).single();
  if (error || !event) {
    req.session.adminError = "Event not found.";
    return res.redirect("/admin/dashboard");
  }

  const bracket = typeof event.bracket === "string" ? JSON.parse(event.bracket) : event.bracket || { rounds: [] };
  const { data: records } = await supabase
    .from("player_event_records")
    .select("player_id, wins, losses, players(username)")
    .eq("event_id", eventId);

  const adminMessage = req.session.adminMessage || null;
  const adminError = req.session.adminError || null;
  req.session.adminMessage = null;
  req.session.adminError = null;

  res.render("event", {
    event,
    bracket,
    adminView: true,
    records: records || [],
    adminMessage,
    adminError,
    user: req.session.user || null,
    admin: req.session.admin || null,
  });
});

app.post("/admin/events/:id/report", requireAdmin, async (req, res) => {
  const eventId = req.params.id;
  const { matchId, winnerId } = req.body;

  if (!matchId || !winnerId) {
    req.session.adminError = "Match and winner are required.";
    return res.redirect(`/admin/events/${eventId}`);
  }

  try {
    const { data: event, error: eventError } = await supabase.from("events").select("*").eq("id", eventId).single();
    if (eventError || !event) {
      req.session.adminError = "Event not found.";
      return res.redirect("/admin/dashboard");
    }

    const bracket = typeof event.bracket === "string" ? JSON.parse(event.bracket) : event.bracket || { rounds: [] };
    const match = findMatch(bracket, matchId);

    if (!match) {
      req.session.adminError = "Match not found in bracket.";
      return res.redirect(`/admin/events/${eventId}`);
    }
    if (match.autoAdvance) {
      req.session.adminError = "Auto-advanced matches cannot be overridden.";
      return res.redirect(`/admin/events/${eventId}`);
    }
    if (!match.player1 || !match.player2) {
      req.session.adminError = "Both players must be set before recording a result.";
      return res.redirect(`/admin/events/${eventId}`);
    }
    if (match.winner) {
      req.session.adminError = "This match result has already been recorded.";
      return res.redirect(`/admin/events/${eventId}`);
    }

    let winnerPlayer = null;
    let loserPlayer = null;
    if (String(match.player1.id) === String(winnerId)) {
      winnerPlayer = match.player1;
      loserPlayer = match.player2;
    } else if (String(match.player2.id) === String(winnerId)) {
      winnerPlayer = match.player2;
      loserPlayer = match.player1;
    } else {
      req.session.adminError = "Winner must be one of the match participants.";
      return res.redirect(`/admin/events/${eventId}`);
    }

    match.winner = winnerPlayer;
    match.loser = loserPlayer;
    match.completedAt = new Date().toISOString();
    assignWinnerToNextMatch(bracket, match);

    const { error: updateError } = await supabase
      .from("events")
      .update({ bracket })
      .eq("id", eventId);
    if (updateError) throw updateError;

    const { data: winnerRecord } = await supabase
      .from("player_event_records")
      .select("wins, losses")
      .eq("event_id", event.id)
      .eq("player_id", winnerPlayer.id)
      .maybeSingle();

    await supabase.from("player_event_records").upsert(
      [
        {
          event_id: event.id,
          player_id: winnerPlayer.id,
          wins: (winnerRecord?.wins || 0) + 1,
          losses: winnerRecord?.losses || 0,
        },
      ],
      { onConflict: "event_id,player_id" }
    );

    if (loserPlayer) {
      const { data: loserRecord } = await supabase
        .from("player_event_records")
        .select("wins, losses")
        .eq("event_id", event.id)
        .eq("player_id", loserPlayer.id)
        .maybeSingle();

      await supabase.from("player_event_records").upsert(
        [
          {
            event_id: event.id,
            player_id: loserPlayer.id,
            wins: loserRecord?.wins || 0,
            losses: (loserRecord?.losses || 0) + 1,
          },
        ],
        { onConflict: "event_id,player_id" }
      );
    }

    req.session.adminMessage = "Match result recorded.";
    res.redirect(`/admin/events/${eventId}`);
  } catch (error) {
    console.error("Failed to record match", error);
    req.session.adminError = "Failed to record match result.";
    res.redirect(`/admin/events/${eventId}`);
  }
});

// Enhanced Admin Dashboard with management tables
app.get("/admin/dashboard", requireAdmin, async (req, res) => {
  const { data: games } = await supabase.from("games").select("*").order("name");
  const { data: players } = await supabase.from("players").select("*").order("username");
  const { data: stats } = await supabase
    .from("player_stats")
    .select("id, player_id, game, kit, tier, points, players(username)")
    .order("points", { ascending: false });
  const { data: events } = await supabase
    .from("events")
    .select("id, name, game, kit, created_at")
    .order("created_at", { ascending: false });

  const adminMessage = req.session.adminMessage || null;
  const adminError = req.session.adminError || null;
  req.session.adminMessage = null;
  req.session.adminError = null;

  res.render("admin-dashboard", {
    admin: req.session.admin,
    games: games || [],
    players: players || [],
    stats: stats || [],
    events: events || [],
    TIERS,
    adminMessage,
    adminError,
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
