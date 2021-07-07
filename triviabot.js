const entities = require("html-entities").AllHtmlEntities;
const fs = require("fs");
const JSON = require("circular-json");
const { GameHandler, Game } = require("./lib/game_handler.js");

var ConfigData = require("./lib/config.js")(process.argv[2]);
var Config = ConfigData.config;
var ConfigLocal = {};

var Trivia = exports;
Trivia.gameHandler = new GameHandler(Trivia);
var game = Trivia.gameHandler.activeGames;

// getConfigValue(value, channel, guild)
// channel: Unique identifier for the channel. If blank, falls back to guild.
//          If detected as a discord.js TextChannel object, automatically fills the
//          ID for itself and the guild.
// guild: Unique identifier for the server. If blank, falls back to global.
function getConfigVal(value, channel, guild) {
  if(typeof channel !== "undefined") {
    // discord.js class auto-detection
    if(channel.type === "text") {
      guild = channel.guild.id;
      channel = channel.id;
    }
    else if(channel.type === "dm") {
      channel = channel.id;
    }
  }

  // "channel" refers to the channel's ID.

  var file = `./Options/config_${channel}.json`;
  if(typeof channel !== "undefined" && fs.existsSync(file)) {
    if(typeof ConfigLocal[channel] === "undefined") {
      // If the data isn't in the cache, load it from file.
      if(ConfigData.localOptions.includes(value)) {
        var currentConfig;
        try {
          currentConfig = fs.readFileSync(file).toString();

          currentConfig = JSON.parse(currentConfig);

          // Cache the data so it doesn't need to be re-read.
          // This also eliminates issues if the file is changed without restarting.
          ConfigLocal[channel] = currentConfig;

          // If the value doesn't exist, will attempt to fall back to global
          if(typeof currentConfig[value] !== "undefined") {
            return currentConfig[value];
          }
        } catch(error) {
          // If this fails, fall back to default config and drop an error in the console.
          console.log(`Failed to retrieve config option "${value}". Default option will be used instead.`);
          console.log(error.stack);
        }
      }
    }
    else {
      // This data is already in the cache, return it from there.
      if(typeof ConfigLocal[channel][value] !== "undefined") {
        return ConfigLocal[channel][value];
      }
    }
  }

  guild;

  if(value.toLowerCase().includes("token")) {
    throw new Error("Attempting to retrieve a token through getConfigVal. This may indicate a bad module or other security risk.");
  }

  return Config[value];
}
Trivia.getConfigVal = getConfigVal;

function setConfigVal(value, newValue, skipOverride, localID) {
  var isLocal = typeof localID !== "undefined";
  if(skipOverride !== true || !getConfigVal("config-commands-enabled")) {
    // TEMPORARY: This is an extra failsafe to make sure this only runs when intended.
    return;
  }

  if(value.toLowerCase().includes("token")) {
    return -1;
  }

  var file = ConfigData.configFile;
  var configToWrite = JSON.parse(JSON.stringify(Config));

  if(isLocal) {
    if(isLocal) {
      file = `./Options/config_${localID}.json`;
    }

    // Get the value first so the file caches in case it hasn't already.
    getConfigVal(value, localID);

    if(fs.existsSync(file)) {
      configToWrite = fs.readFileSync(file).toString();

      configToWrite = JSON.parse(configToWrite);
    }
    // If the file doesn't exist, use the global config.
  }

  if(newValue === null) {
    delete configToWrite[value.toLowerCase()];
  }
  else {
    configToWrite[value.toLowerCase()] = newValue;
  }

  if(isLocal) {
    file = `./Options/config_${localID}.json`;

    // Filter out the options that are not global values.
    for(var key in configToWrite) {
      if(!ConfigData.localOptions.includes(key)) {
        delete configToWrite[key];
      }
    }
  }

  fs.writeFile(file, JSON.stringify(configToWrite, null, "\t"), "utf8", (err) => {
    if(err) {
      throw err;
    }
  });
}
Trivia.setConfigVal = setConfigVal;

global.client.on("ready", () => {
  // Initialize restricted channels
  var restrictedChannelsInput = getConfigVal("channel-whitelist");
  Trivia.restrictedChannels = [];
  if(typeof restrictedChannelsInput !== "undefined" && restrictedChannelsInput.length !== 0) {
    // Can't use for..in here because is isn't supported by Map objects.
    global.client.channels.cache.forEach((channel) => {
      for(var i in restrictedChannelsInput) {
        var channelInput = restrictedChannelsInput[i];

        if(Trivia.restrictedChannels.length === restrictedChannelsInput.length) {
          break;
        }

        if(channelInput === channel.id.toString()) {
          Trivia.restrictedChannels.push(channel.id);
        }
        else if(channelInput.toString().replace("#", "").toLowerCase() === channel.name) {
          Trivia.restrictedChannels.push(channel.id);
        }
      }

    });
  }
});

// TODO: Use String.fromCharCode(65+letter) instead of this array?
const Letters = ["A", "B", "C", "D"];
// Convert the hex code to decimal so Discord can read it.
Trivia.embedCol = Buffer.from(getConfigVal("embed-color").padStart(8, "0"), "hex").readInt32BE(0);

var Database = "";
if(getConfigVal("database-merge")) {
  // TODO: Rather than killing the base process, the manager should
  // do this automatically when an initial error is thrown.
  if(!Config.databaseURL.startsWith("file://")) {
    console.error("A file path starting with 'file://' must be specified when the database merger is enabled.");
    global.client.shard.send({evalStr: "process.exit();"});
  }

  Database = require("./lib/database/mergerdb.js")(Config);
}
else {
  Database = Config.databaseURL.startsWith("file://")?require("./lib/database/filedb.js")(Config):require("./lib/database/opentdb.js")(Config);
}

if(typeof Database === "undefined" || Database.error) {
  console.error("Failed to load the database.");
  global.client.shard.send({evalStr: "process.exit();"});
}

Trivia.database = Database;

Trivia.questions = [];


// Generic message sending function.
// This is to avoid repeating the same error catchers throughout the script.
//    channel: Channel ID
//    author: Author ID (Omit to prevent error messages from going to the author's DMs)
//    msg: Message Object
//    noDelete: If enabled, message will not auto-delete even if configured to
// TODO rewrite
Trivia.send = async function(channel, author, msg, callback, noDelete) {
  try {
    msg = await channel.send(msg);
  } catch(err) {
    console.warn("Message send error: " + err);
    console.trace();
    if(typeof author !== "undefined") {
      if(channel.type !== "dm") {
        var str = "";
        if(err.message.includes("Missing Permissions")) {
          str = "\n\nThe bot does not have sufficient permission to send messages in this channel. This bot requires the \"Read Messages\", \"Send Messages\", \"Embed Links\" permissions in order to work.";
        }

        if(err.message.includes("Missing Access")) {
          str = "\n\nThe bot does not have permission to read messages in this channel. This bot requires the \"Read Messages\", \"Send Messages\", \"Embed Links\" permissions in order to work.";
        }

        author.send({embed: {
          color: 14164000,
          description: `TriviaBot is unable to send messages in this channel:\n${err.message.replace("DiscordAPIError: ","")} ${str}`
        }})
        .catch(() => {
          console.warn(`Failed to send message to user ${author.id}, DM failed. Dumping message data...`);
          console.log(msg);
          console.log("Dumped message data.");
        });
      }
      else {
        console.warn(`Failed to send message to user ${author.id}. (already in DM)`);
      }
    }
    else {
      console.warn("Failed to send message to channel, user object nonexistent. Dumping message data...");
      console.log(msg);
    }
  }
  if(getConfigVal("auto-delete-msgs", channel) && noDelete !== true) {
    setTimeout(() => {
      msg.delete();
    }, getConfigVal("auto-delete-msgs-timer", msg.channel));
  }
  
  return msg;
};

Trivia.commands = {};
var commands = Trivia.commands;

function isFallbackMode(channel) {
  if(getConfigVal("fallback-mode")) {
    if(typeof getConfigVal("fallback-exceptions") !== "undefined" && getConfigVal("fallback-exceptions").indexOf(channel) !== -1) {
      // Return if specified channel is an exception
      return;
    }
    else {
      return true;
    }
  }
}

// getTriviaQuestion
// Returns a promise, fetches a random question from the database.
// If initial is set to true, a question will not be returned. (For initializing the cache)
// If tokenChannel is specified (must be a discord.js TextChannel object), a token will be generated and used.
Trivia.getTriviaQuestion = async function(initial, tokenChannel, tokenRetry, isFirstQuestion, category, typeInput, difficultyInput) {
  var length = Trivia.questions.length;
  var toReturn;

  // Check if there are custom arguments
  var isCustom = false;
  if(typeof category !== "undefined" || typeof typeInput !== "undefined" || typeof difficultyInput !== "undefined") {
    isCustom = true;
  }

  // To keep the question response quick, the bot always stays one question ahead.
  // This way, we're never waiting for the database to respond.
  if(typeof length === "undefined" || length < 2 || isCustom) {
    // We need a new question, either due to an empty cache or because we need a specific category.
    var options = {};
    options.category = category; // Pass through the category, even if it's undefined.

    if(isCustom || Config.databaseURL.startsWith("file://")) {
      options.amount = 1;
    }
    else {
      options.amount = getConfigVal("database-cache-size");
    }

    options.type = typeInput;
    options.difficulty = difficultyInput;

    // Get a token if one is requested.
    var token;
    if(typeof tokenChannel !== "undefined") {
      try {
        token = await Database.getTokenByIdentifier(tokenChannel.id);

        if(getConfigVal("debug-mode")) {
          Trivia.send(tokenChannel, void 0, `*DB Token: ${token}*`);
        }
      } catch(error) {
        // Something went wrong. We'll display a warning but we won't cancel the game.
        console.log(`Failed to generate token for channel ${tokenChannel.id}: ${error.message}`);

        // Skip display of session token messages if a pre-defined error message has been written.
        if(typeof Trivia.maintenanceMsg !== "string") {
          Trivia.send(tokenChannel, void 0, {embed: {
            color: 14164000,
            description: `Error: Failed to generate a session token for this channel. You may see repeating questions. (${error.message})`
          }});
        }
      }

      if(typeof token !== "undefined" && (isCustom || Config.databaseURL.startsWith("file://")) ) {
        // Set the token and continue.
        options.token = token;
      }
    }

    var json = {};
    var err;
    try {
      json = await Database.fetchQuestions(options);

      if(getConfigVal("debug-database-flush") && !tokenRetry && typeof token !== "undefined") {
        err = new Error("Token override");
        err.code = 4;
        throw err;
      }
    } catch(error) {
      if(error.code === 4 && typeof token !== "undefined") {
        // Token empty, reset it and start over.
        if(tokenRetry !== 1) {
          try {
            await Database.resetToken(token);
          } catch(error) {
            console.log(`Failed to reset token - ${error.message}`);
            throw new Error(`Failed to reset token - ${error.message}`);
          }

          if(!isFirstQuestion) {
            if(typeof category === "undefined") {
              Trivia.send(tokenChannel, void 0, "You've played all of the available questions! Questions will start to repeat.");
            }
            else {
              Trivia.send(tokenChannel, void 0, "You've played all of the questions in this category! Questions will start to repeat.");
            }
          }

          // Start over now that we have a token.
          return await Trivia.getTriviaQuestion(initial, tokenChannel, 1, isFirstQuestion, category, typeInput, difficultyInput);
        }
        else {
          if(isFirstQuestion) {
            err = new Error("There are no questions available under the current configuration.");
            err.code = -1;
            throw err;
          }
          else {
            // This shouldn't ever happen.
            throw new Error("Token reset loop.");
          }
        }
      }
      else {
        // If an override has been set, show a shortened message instead
        if(typeof Trivia.maintenanceMsg !== "string") {
          console.log("Received error from the trivia database!");
          console.log(error);
          console.log(json);
        }
        else {
          console.log("Error from trivia database, displaying canned response");
        }

        // Delete the token so we'll generate a new one next time.
        // This is to fix the game in case the cached token is invalid.
        if(typeof token !== "undefined") {
          delete Database.tokens[tokenChannel.id];
        }

        // Author is passed through; Trivia.send will handle it if author is undefined.
        throw new Error(`Failed to query the trivia database with error code ${json.response_code} (${Database.responses[json.response_code]}; ${error.message})`);
      }
    }
    finally {
      Trivia.questions = json;
    }
  }

  if(!initial) {
    // Just in case, check the cached question count first.
    if(Trivia.questions.length < 1) {
      throw new Error("Received empty response while attempting to retrieve a Trivia question.");
    }
    else {
      toReturn = Trivia.questions[0];

      delete Trivia.questions[0];
      Trivia.questions = Trivia.questions.filter((val) => Object.keys(val).length !== 0);

      return toReturn;
    }
  }
};

// Initialize the question cache
if(!Config.databaseURL.startsWith("file://")) {
  Trivia.getTriviaQuestion(1)
  .catch((err) => {
    console.log(`An error occurred while attempting to initialize the question cache:\n ${err}`);
  });
}

Trivia.applyBonusMultiplier = (game, channel, userID) => {
  var score = getConfigVal("score-value", channel)[game.question.difficulty];

  var multiplier;

  var multiplierBase = getConfigVal("score-multiplier-max", channel);
  if(multiplierBase !== 0) {
    var index = Object.keys(game.activeParticipants).indexOf(userID)+1;

    // Score multiplier equation
    multiplier = multiplierBase/index+1;

    // Don't apply if the number is negative or passive.
    if(multiplier > 1) {
      var bonus = Math.floor((score*multiplier)-score);

      return bonus;
    }
  }
};

// # Trivia.doAnswerReveal #
// Ends the round, reveals the answer, and schedules a new round if necessary.
// TODO: Refactor (clean up and fix gameEndedMsg being relied on as a boolean check)
Trivia.doAnswerReveal = (game, channel, answer, importOverride) => {
  game.roundCount++;
  if(typeof game === "undefined" || !game.inProgress) {
    return;
  }

  var roundTimeout = getConfigVal("round-timeout", channel);

  if(typeof game.message !== "undefined" && getConfigVal("auto-delete-msgs", channel)) {
    game.message.delete()
    .catch((err) => {
      console.log(`Failed to delete message - ${err.message}`);
    });
  }

  // Quick fix for timeouts not clearing correctly.
  if(answer !== game.question.answer && !importOverride) {
    console.warn(`WARNING: Mismatched answers in timeout for game ${game.ID} (${answer}||${game.question.answer})`);
    return;
  }

  game.inRound = false;

  // Custom options
  // Custom round count subtracts by 1 until reaching 0, then the game ends.
  if(typeof game.options.customRoundCount !== "undefined") {
    game.options.customRoundCount = game.options.customRoundCount-1;

    if(typeof game.options.intermissionTime !== "undefined" && game.options.customRoundCount <= game.options.totalRoundCount/2) {
      roundTimeout = game.options.intermissionTime;

      Trivia.send(channel, void 0, `Intermission - Game will resume in ${roundTimeout/60000} minute${roundTimeout/1000===1?"":"s"}.`);
      game.options.intermissionTime = void 0;
    }
    else if(game.options.customRoundCount <= 0) {
      setTimeout(() => {
        Trivia.stopGame(game, channel, true);
        return;
      }, 100);
    }
  }

  var correctUsersStr = "**Correct answer:**\n";

  var scoreStr = "";

  // If only one participant, we'll only need the first user's score.
  if(!getConfigVal("disable-score-display", channel)) {
    var scoreVal = game.scores[Object.keys(game.correctUsers)[0]];

    if(typeof scoreVal !== "undefined") {
      if(isNaN(game.scores[ Object.keys(game.correctUsers)[0] ])) {
        console.log("WARNING: NaN score detected, dumping game data...");
      }

      scoreStr = `(${scoreVal.toLocaleString()} points)`;
    }
  }

  var gameEndedMsg = "", gameFooter = "";
  var doAutoEnd = 0;
  if(game.cancelled) {
    gameEndedMsg = "\n\n*Game ended by admin.*";
  }
  else if(Object.keys(game.activeParticipants).length === 0 && !game.options.customRoundCount) {
    // If there were no participants...
    if(game.emptyRoundCount+1 >= getConfigVal("rounds-end-after", channel)) {
      doAutoEnd = 1;
      gameEndedMsg = "\n\n*Game ended.*";
    } else {
      game.emptyRoundCount++;

      // Round end warning after we're halfway through the inactive round cap.
      if(!getConfigVal("round-end-warnings-disabled", channel) && game.emptyRoundCount >= Math.ceil(getConfigVal("rounds-end-after", channel)/2)) {
        var roundEndCount = getConfigVal("rounds-end-after", channel.id)-game.emptyRoundCount;
        gameFooter += `Game will end in ${roundEndCount} round${roundEndCount===1?"":"s"} if there is no activity.`;
      }
    }
  } else {
    // If there are participants and the game wasn't force-cancelled...
    game.emptyRoundCount = 0;
    doAutoEnd = 0;
  }

  if((gameEndedMsg === "" || getConfigVal("disable-score-display", channel)) && !getConfigVal("full-score-display", channel) ) {
    var truncateList = 0;

    if(Object.keys(game.correctUsers).length > 32) {
      truncateList = 1;
    }

    // ## Normal Score Display ## //
    if(Object.keys(game.correctUsers).length === 0) {
      if(Object.keys(game.activeParticipants).length === 1) {
        correctUsersStr = `Incorrect, ${Object.values(game.activeParticipants)[0]}!`;
      }
      else {
        correctUsersStr = correctUsersStr + "Nobody!";
      }
    }
    else {
      if(Object.keys(game.activeParticipants).length === 1) {
        // Only one player overall, simply say "Correct!"
        // Bonus multipliers don't apply for single-player games
        correctUsersStr = `Correct, ${Object.values(game.correctUsers)[0]}! ${scoreStr}`;
      }
      else  {
        // More than 10 correct players, player names are separated by comma to save space.
        var comma = ", ";
        var correctCount = Object.keys(game.correctUsers).length;

        // Only show the first 32 scores if there are a lot of players.
        // This prevents the bot from potentially overflowing the embed character limit.
        if(truncateList) {
          correctCount = 32;
        }

        for(var i = 0; i <= correctCount-1; i++) {
          if(i === correctCount-1) {
            comma = "";
          }
          else if(correctCount <= 10) {
            comma = "\n";
          }

          var score = game.scores[ Object.keys(game.correctUsers)[i] ];

          var bonusStr = "";
          var bonus = Trivia.applyBonusMultiplier(game.ID, channel, Object.keys(game.correctUsers)[i]);

          if(getConfigVal("debug-log")) {
            console.log(`Applied bonus score of ${bonus} to user ${Object.keys(game.correctUsers)[i]}`);
          }

          if(score !== score+bonus && typeof bonus !== "undefined") {
            bonusStr = ` + ${bonus} bonus`;
          }
          else {
            bonus = 0;
          }

          if(!getConfigVal("disable-score-display", channel)) {
            scoreStr = ` (${score.toLocaleString()} pts${bonusStr})`;
          }

          // Apply bonus after setting the string.
          game.scores[ Object.keys(game.correctUsers)[i] ] = score+bonus;

          correctUsersStr = `${correctUsersStr}${Object.values(game.correctUsers)[i]}${scoreStr}${comma}`;
        }

        if(truncateList) {
          var truncateCount = Object.keys(game.correctUsers).length-32;
          correctUsersStr = `${correctUsersStr}\n*+ ${truncateCount} more*`;
        }
      }
    }
  }
  else {
    // ## Game-Over Score Display ## //
    var totalParticipantCount = Object.keys(game.totalParticipants).length;

    if(gameEndedMsg === "") {
      correctUsersStr = `**Score${totalParticipantCount!==1?"s":""}:**`;
    } else {
      correctUsersStr = `**Final score${totalParticipantCount!==1?"s":""}:**`;
    }

    if(totalParticipantCount === 0) {
      correctUsersStr = `${correctUsersStr}\nNone`;
    }
    else {
      correctUsersStr = `${correctUsersStr}\n${Trivia.leaderboard.makeScoreStr(game.scores, game.totalParticipants)}`;
    }
  }

  if(gameFooter !== "") {
    gameFooter = "\n\n" + gameFooter;
  }

  var answerStr = "";

  if(getConfigVal("reveal-answers", channel) === true) { // DELTA: Answers will be not shown in the Summary
    answerStr = `${game.gameMode!==2?`**${Letters[game.question.displayCorrectID]}:** `:""}${entities.decode(game.question.answer)}\n\n`;
  }

  Trivia.send(channel, void 0, {embed: {
    color: game.color,
    description: `${answerStr}${correctUsersStr}${gameEndedMsg}${gameFooter}`
  }})
  .catch(() => {
    game.timeout = void 0;
    game.endGame();
  })
  .then((msg) => {
    if(typeof game !== "undefined" && !doAutoEnd && !game.cancelled) {
      // NOTE: Participants check is repeated below in Trivia.doGame
      game.timeout = setTimeout(() => {
        if(getConfigVal("auto-delete-msgs", channel)) {
          msg.delete()
          .catch((err) => {
            console.log(`Failed to delete message - ${err.message}`);
          });
        }
        Trivia.doGame(game.ID, channel, void 0, 1);
      }, roundTimeout);
    }
  });
};

// # parseAnswerHangman # //
// This works by parsing the string, and if it matches the answer, passing it
// to parseAnswer as the correct letter.
Trivia.parseAnswerHangman = function(game, str, id, userId, username, scoreValue) {
  var input = str.toLowerCase();
  // Decode and remove all non-alphabetical characters
  var answer = entities.decode(game.question.answer).toLowerCase().replace(/\W/g, "");

  // Return -1 if the input is a command.
  // If the input is much longer than the actual answer, assume that it is not an attempt to answer.
  if(input.startsWith(getConfigVal("prefix", id)) || input.length > answer.length*2) {
    return -1;
  }

  if(input.replace(/\W/g, "") === answer) {
    return Trivia.parseAnswer(game, Letters[game.question.displayCorrectID], id, userId, username, scoreValue);
  }
  else {
    // The string doesn't match, so we'll pass the first incorrect answer.
    var incorrect = Letters.slice(0); // Copy to avoid modifying it
    incorrect.splice(game.question.displayCorrectID, 1);
    return Trivia.parseAnswer(game, incorrect[0], id, userId, username, scoreValue);
  }
};

// # Trivia.parseAnswer # //
// Parses a user's letter answer and scores it accordingly.
// Str: Letter answer -- id: channel identifier
// scoreValue: Score value from the config file.
Trivia.parseAnswer = function (game, str, channelId, userId, username, scoreValue) {
  if(!game.inRound) {
    // Return -1 since there is no game.
    return -1;
  }

  // If they already answered and configured to do so, don't accept subsquent answers.
  if(getConfigVal("accept-first-answer-only", channelId) && typeof game.activeParticipants[userId] !== "undefined") {
    return;
  }

  if((str === "A" || str === "B" || game.isTrueFalse !== 1 && (str === "C"|| str === "D"))) {
    // Add to participants if they aren't already on the list
    if(game.inProgress && typeof game.activeParticipants[userId] === "undefined") {
      game.activeParticipants[userId] = username;

      game.totalParticipants[userId] = username;
    }

    // If their score doesn't exist, intialize it.
    game.scores[userId] = game.scores[userId] || 0;

    if(str === Letters[game.question.displayCorrectID]) {
      if(typeof game.correctUsers[userId] === "undefined") {
        game.correctUsers[userId] = username;

        var scoreChange = 0;
        if(typeof scoreValue[game.question.difficulty] === "number") {
          scoreChange = scoreValue[game.question.difficulty];
        }
        else {
          // Leave the score change at 0, display a warning.
          console.warn(`WARNING: Invalid difficulty value '${game.question.difficulty}' for the current question. User will not be scored.`);
        }

        if(getConfigVal("debug-log")) {
          console.log(`Updating score of user ${userId} (Current value: ${game.scores[userId]}) + ${scoreChange}.`);
        }

        game.scores[userId] += scoreChange;

        if(getConfigVal("debug-log")) {
          console.log(`New score for user ${userId}: ${game.scores[userId]}`);
        }
      }
    }
    else {
      // If the answer is wrong, remove them from correctUsers if necessary
      if(typeof game.correctUsers[userId] !== "undefined") {

        if(getConfigVal("debug-log")) {
          console.log(`User ${userId} changed answers, reducing score (Current value: ${game.scores[userId]}) by ${scoreValue[game.question.difficulty]}.`);
        }

        game.scores[userId] -= scoreValue[game.question.difficulty];

        if(getConfigVal("debug-log")) {
          console.log(`New score for user ${userId}: ${game.scores[userId]}`);
        }

        // Now that the name is removed, we can remove the ID.
        delete game.correctUsers[userId];
      }
    }
  }
  else {
    // Return -1 to indicate that the input is NOT a valid answer
    return -1;
  }
};

async function addAnswerReactions(msg, game) {
  try {
    await msg.react("🇦");
    await msg.react("🇧");

    if(typeof game === "undefined" || !game.isTrueFalse) {
      await msg.react("🇨");
      await msg.react("🇩");
    }
  } catch (error) {
    console.log(`Failed to add reaction: ${error}`);

    Trivia.send(msg.channel, void 0, {embed: {
      color: 14164000,
      description: "Error: Failed to add reaction. This may be due to the channel's configuration.\n\nMake sure that the bot has the \"Use Reactions\" and \"Read Message History\" permissions or disable reaction mode to play."
    }});

    msg.delete();
    game.endGame();
    return;
  }
}

Trivia.createObscuredAnswer = function(answer, doHint) {
  var obscuredAnswer = "";
  var skipChars = [];

  if(doHint) {
    // Randomly reveal up to 1/3 of the answer.
    var charsToReveal = answer.length/3;
    for(var i = 0; i <= charsToReveal; i++) {
      var skipChar = Math.floor(Math.random() * answer.length);
      skipChars.push(skipChar);
    }
  }

  for(var charI = 0; charI <= answer.length-1; charI++) {
    var char = answer.charAt(charI);

    if(char === " ") {
      obscuredAnswer = `${obscuredAnswer} `;
    }
    else if(skipChars.includes(charI) || char === "," || char === "\"" || char === "'" || char === ":" || char === "(" || char === ")") {
      // If this character is set to be revealed or contains an exception, show it.
      obscuredAnswer = `${obscuredAnswer}${char}`;
    }
    else {
      // A thin space character (U+2009) is used so the underscores have
      // a small distinguishing space between them.
      // ESLint really doesn't like this, but it works great!
      obscuredAnswer = `${obscuredAnswer}\\_ `;
    }
  }

  return obscuredAnswer;
};

function doHangmanHint(channel, answer) {
  var game = Trivia.gameHandler.getActiveGame(channel.id);

  // Verify that the game is still running and that it's the same game.
  if(typeof game === "undefined" || !game.inRound || answer !== game.answer) {
    return;
  }

  answer = entities.decode(answer);

  // If the total string is too small, skip showing a hint.
  if(answer.length < 4) {
    return;
  }

  var hintStr = Trivia.createObscuredAnswer(answer, true);

  Trivia.send(channel, void 0, {embed: {
    color: Trivia.embedCol,
    description: `Hint: ${hintStr}`
  }});
}

// # Trivia.doGame #
// - id: The unique identifier for the channel that the game is in.
// - channel: The channel object that correlates with the game.
// - author: The user that started the game. Can be left 'undefined'
//           if the game is scheduled.
// - scheduled: Set to true if starting a game scheduled by the bot.
//              Keep false if starting on a user's command. (must
//              already have a game initialized to start)
Trivia.doGame = async function(id, channel, author, question, mode) {
  if(commands.playAdv.advGameExists(id)) {
    return;
  }

  var authorId;
  if(typeof author === "undefined") {
    authorId = void 0;
  }
  else {
    authorId = author.id;
  }

  // ## Game ##
  // Define the variables for the new game.
  // NOTE: This is run between rounds, plan accordingly.
  var game = Trivia.gameHandler.getActiveGame(channel.id);

  if(typeof game === "undefined") {
    game = new Game(Trivia.gameHandler, channel.id, channel.guild.id, authorId, question, mode);

    game.on("game_error", (err) => {
      if(err.code !== -1) {
        console.log("Database query error:");
        console.log(err);
      }
      Trivia.send(channel, author, {embed: {
        color: 14164000,
        description: `An error occurred while querying the trivia database: ${err}`
      }});
    });
  }

  var finalString = await game.initializeRound();
  var msg;
  try {
    msg = await Trivia.send(channel, author, {embed: {
      color: game.color,
      description: finalString
    }});

  } catch(err) {
    game.timeout = void 0; // TODO
    game.endGame();
    throw err;
  }

  game.startRound();
  game.message = msg;

  // Add reaction emojis if configured to do so.
  if(game.gameMode === 1) {
    addAnswerReactions(msg, game);
  }

  if(game.gameMode === 2 && getConfigVal("hangman-hints", channel) === true) {  // DELTA: Added deactivatable hangman hints
    // Show a hint halfway through.
    // No need for special handling here because it will auto-cancel if
    // the game ends before running.
    var answer = game.question.answer; // Pre-define to avoid errors.
    setTimeout(() => {
      doHangmanHint(game, answer);
    },
    getConfigVal("round-length", channel)/2);
  }

  // Reveal the answer after the time is up
  game.timeout = setTimeout(() => {
    Trivia.doAnswerReveal(game, channel, game.question.answer);
  }, getConfigVal("round-length", channel));
  
  return game;
};

Trivia.stopGame = (game, channel, auto) => {
  if(auto !== 1) {
    global.client.shard.send({stats: { commandStopCount: 1 }});
  }

  // These are defined beforehand so we can refer to them after the game is deleted.
  let timeout = game.timeout;
  let inRound = game.inRound;
  let finalScoreStr = Trivia.leaderboard.makeScoreStr(game.scores, game.totalParticipants);
  let totalParticipantCount = Object.keys(game.totalParticipants).length;

  game.cancelled = 1;

  if(typeof timeout !== "undefined" && typeof timeout._onTimeout === "function") {
    var onTimeout = timeout._onTimeout;
    clearTimeout(timeout);

    // If a round is in progress, display the answers before cancelling the game.
    // The game will detect "cancelled" and display the proper message.
    if(game.inRound && typeof timeout !== "undefined") {
      onTimeout();
    }
  }

  // If there's still a game, clear it.
  if(typeof game !== "undefined") {
    game.endGame();
  }

  // Display a message if between rounds
  if(!inRound && !game.getConfig("use-fixed-rounds")) { // DELTA: Only if no fixed rounds are played.
    var headerStr = `**Final score${totalParticipantCount!==1?"s":""}:**`;

    Trivia.send(channel, void 0, {embed: {
      color: Trivia.embedCol,
      description: `Game ended by admin.${finalScoreStr!==""?`\n\n${headerStr}\n`:""}${finalScoreStr}`
    }});
  }
};

Trivia.leaderboard = require("./lib/leaderboard.js")(getConfigVal);
commands.playAdv = require("./lib/cmd_play_advanced.js")(Trivia, global.client);
var parseAdv = commands.playAdv.parseAdv;
commands.triviaHelp = require("./lib/cmd_help.js")(Config, Trivia);
commands.triviaCategories = require("./lib/cmd_categories.js")(Config);
commands.triviaPlayAdvanced = commands.playAdv.triviaPlayAdvanced;
commands.triviaPing = require("./lib/cmd_ping.js")(Config, Trivia, Database);
commands.triviaStop = require("./lib/cmd_stop.js")(Config, Trivia, commands, getConfigVal);

Trivia.buildCategorySearchIndex = async () => {
  Trivia.categorySearchIndex = JSON.parse(JSON.stringify(await Database.getCategories()));

  for(var el in Trivia.categorySearchIndex) {
    var index = Trivia.categorySearchIndex[el];
    index.indexName = index.name.toUpperCase().replace(":", "").replace(" AND ", " & ");
  }
};

// getCategoryFromStr
// Returns a category based on the string specified. Returns undefined if no category is found.
Trivia.getCategoryFromStr = async (str) => {
  // Automatically give "invalid category" if query is shorter than 3 chars.
  if(str.length < 3) {
    return void 0;
  }

  // If we haven't already, initialize a category list index.
  if(typeof Trivia.categorySearchIndex === "undefined") {
    await Trivia.buildCategorySearchIndex();
  }

  var strCheck = str.toUpperCase().replace(":", "").replace(" AND ", " & ");
  return Trivia.categorySearchIndex.find((el) => {
    return el.indexName.toUpperCase().includes(strCheck);
  });
};

function parseCommand(msg, cmd) {
  var game = Trivia.gameHandler.getActiveGame(msg.channel.id);

  var isAdmin;
  if(getConfigVal("disable-admin-commands", msg.channel) !== true) {
    // Admin if there is a valid member object and they have permission.
    if(msg.member !== null && msg.member.permissions.has("MANAGE_GUILD")) {
      isAdmin = true;
    }
    else if(msg.channel.type === "dm") {
      // Admin if the game is run in a DM.
      isAdmin = true;
    }
    else if(getConfigVal("command-whitelist", msg.channel).length > 0) {
      // Admin if they are whitelisted (No need to check here -- if the command ran, they're whitelisted)
      isAdmin = true;
    }
  }

  if(cmd === "PING") {
    commands.triviaPing(msg);
    return;
  }

  if(cmd.startsWith("STOP")) {
    commands.triviaStop(msg, cmd, isAdmin);
  }

  if(cmd.startsWith("CONFIG")) {
    if(isAdmin && getConfigVal("config-commands-enabled")) {
      var cmdInput = cmd.replace("CONFIG ","");

      if(cmdInput === "CONFIG") {
        Trivia.send(msg.channel, void 0, `Must specify an option to configure. \`${getConfigVal("prefix")}config <option> <value>\``);
        return;
      }

      if(cmdInput.startsWith("LIST") && cmdInput.indexOf("-") === -1) {

        var listID;
        if(cmdInput !== "CONFIG LIST ") {
          listID = cmdInput.replace("LIST <#","").replace(">","");

          if(isNaN(listID)) {
            listID = void 0;
          }
        }

        var configStr = `**__Config Options__**\nThese are the config options that are currently loaded${typeof listID!=="undefined"?` in the channel <#${listID}>`:""}. Some options require a restart to take effect. Type '${getConfigVal("prefix")}reset' to apply changes.`;

        for(var i in Config) {
          if(i.toString().includes("token") || i.toString().includes("comment") || i.includes("configFile")) {
            continue;
          }
          else {
            var value = getConfigVal(i, listID);

            var outputStr = value;
            if(typeof outputStr === "object") {
              outputStr = JSON.stringify(outputStr);
            }
            else if(outputStr.toString().startsWith("http")) {
              outputStr = `\`${outputStr}\``; // Surround it with '`' so it doesn't show as a link
            }

            configStr = `${configStr}\n**${i}**: ${outputStr}`;
          }
        }


        if(msg.channel.type !== "dm") {
          Trivia.send(msg.channel, void 0, "Config has been sent to you via DM.");
        }

        Trivia.send(msg.author, void 0, `${configStr}`);
      }
      else {
        var configSplit = cmd.split(" ");
        var configKey = configSplit[1];
        var configVal = cmd.replace(`CONFIG ${configKey} `, "");

        var localID;
        if(configVal.endsWith(">")) {
          var configChannelStr = configVal.slice(configVal.indexOf(" <"), configVal.length);
          localID = configChannelStr.replace(" <#","").replace(">","");
          if(!ConfigData.localOptions.includes(configKey.toLowerCase())) {
            Trivia.send(msg.channel, void 0, "The option specified either does not exist or can only be changed globally.");
            return;
          }

          if(isNaN(localID)) {
            return;
          }

          configVal = configVal.substring(0, configVal.indexOf(" <"));
        }

        // echo is the value that will be sent back in the confirmation message
        var echo = configVal.toLowerCase();
        if(configVal === `CONFIG ${configKey}`) {
          Trivia.send(msg.channel, void 0, `Must specify a value. \`${getConfigVal("prefix")}config <option> <value>\``);
          return;
        }

        if(configVal === "TRUE") {
          configVal = true;
        }
        else if(configVal === "FALSE") {
          configVal = false;
        }
        else if(!isNaN(configVal)) {
          configVal = parseFloat(configVal);
        }
        else if(configVal.startsWith("[") || configVal.startsWith("{")) {
          try {
            configVal = JSON.parse(configVal.toLowerCase());
          } catch(err) {
            Trivia.send(msg.channel, void 0, `The config value specified has failed to parse with the following error:\n${err}`);
            return;
          }

          echo = `\`${JSON.stringify(configVal)}\``;
        }
        else {
          configVal = configVal.toString().toLowerCase();

          if(configVal.startsWith("\"") && configVal.lastIndexOf("\"") === configVal.length-1) {
            configVal = configVal.substr(1, configVal.length-2);
          }

          echo = configVal;
        }

        if(configVal === getConfigVal(configKey.toLowerCase(), msg.channel)) {
          Trivia.send(msg.channel, void 0, `Option ${configKey} is already set to "${echo}" (${typeof configVal}).`);
        }
        else {
          if(configVal === "null") {
            configVal = null;
          }

          var result = setConfigVal(configKey, configVal, true, localID);
          if(result === -1) {
            Trivia.send(msg.channel, void 0, `Unable to modify the option "${configKey}".`);

          }
          else if(configVal === null) {
            Trivia.send(msg.channel, void 0, `Removed option ${configKey} successfully.`);
          }
          else {
            Trivia.send(msg.channel, void 0, `Set option ${configKey} to "${echo}" (${typeof configVal}) ${typeof localID !== "undefined"?`in channel <#${localID}> `:""}successfully.`);
          }
        }
      }
    }
  }

  if(cmd.startsWith("RESET")) {
    if(isAdmin && getConfigVal("config-commands-enabled")) {
      global.client.shard.send({evalStr: "manager.eCmds.exportexit(1);"});
    }
  }

  if(cmd.startsWith("PLAY ADVANCED")) {
    if(typeof game !== "undefined" && game.inProgress) {
      return;
    }

    commands.triviaPlayAdvanced(void 0, msg.channel.id, msg.channel, msg.author, cmd.replace("PLAY ADVANCED",""));
    return;
  }

  if(cmd.startsWith("PLAY ") || cmd === "PLAY") {
    if(typeof game !== "undefined" && game.inProgress) {
      return;
    }

    var categoryInput = cmd.replace("PLAY ","");
    if(categoryInput !== "PLAY") {
      Trivia.getCategoryFromStr(categoryInput)
      .then((category) => {
        if(typeof category === "undefined") {
          Trivia.send(msg.channel, msg.author, {embed: {
            color: 14164000,
            description: `Unable to find the category you specified.\nType \`${getConfigVal("prefix")}play\` to play in random categories, or type \`${getConfigVal("prefix")}categories\` to see a list of categories.`
          }});
          return;
        }
        else {
          Trivia.doGame(msg.channel.id, msg.channel, msg.author, { category: category.id });
          return;
        }
      })
      .catch((err) => {
        Trivia.send(msg.channel, msg.author, {embed: {
          color: 14164000,
          description: `Failed to retrieve the category list:\n${err}`
        }});
        console.log(`Failed to retrieve category list:\n${err}`);
        return;
      });
    }
    else {
      // No category specified, start a normal game. (The database will pick a random category for us)
      Trivia.doGame(msg.channel.id, msg.channel, msg.author);
      return;
    }
  }

  if(typeof commands.leagueParse !== "undefined" && cmd.startsWith("LEAGUE ")) {
    commands.leagueParse(msg, cmd);
    return;
  }

  if(cmd === "CATEGORIES") {
    commands.triviaCategories(msg, Trivia);
    return;
  }
}

// # trivia.parse #
Trivia.parse = (str, msg) => {
  // No games in fallback mode
  if(isFallbackMode(msg.channel.id)) {
    return;
  }

  // Str is always uppercase
  var id = msg.channel.id;
  var game = Trivia.gameHandler.getActiveGame(id);
  var gameExists = typeof game !== "undefined";

  // Other bots can't use commands
  if(msg.author.bot === true && getConfigVal("allow-bots") !== true) {
    return;
  }

  var prefix = getConfigVal("prefix").toUpperCase();

  // ## Answers ##
  // Check for letters if not using reactions
  if(gameExists && game.gameMode !== 1) {
    var name = msg.member !== null?msg.member.displayName:msg.author.username;
    var parse;

    if(game.gameMode === 2) {
      parse = Trivia.parseAnswerHangman;
    }
    else {
      parse = Trivia.parseAnswer;
    }
    var parsed = parse(game, str, id, msg.author.id, name, getConfigVal("score-value", msg.channel));

    if(parsed !== -1) {
      if(getConfigVal("auto-delete-answers", msg.channel)) {
        setTimeout(() => {
          msg.delete()
          .catch((err) => {
            if(err.message !== "Missing Permissions") {
              console.log(err);
              console.log("Failed to delete player answer: " + err.message);
            }
          });
        }, getConfigVal("auto-delete-answers-timer", msg.channel));
      }

      return;
    }
  }

  // Check for command whitelist permissions before proceeding.
  var cmdWhitelist = getConfigVal("command-whitelist", msg.channel);
  if(typeof cmdWhitelist !== "undefined" && cmdWhitelist.length !== 0 && cmdWhitelist.indexOf(msg.author.tag) === -1) {
    return;
  }

  // Check the channel whitelist before proceeding.
  if(Trivia.restrictedChannels.length !== 0) {
    // Cancel if the channel isn't on the whitelist.
    if(Trivia.restrictedChannels.indexOf(msg.channel.id) === -1) {
      return;
    }
  }

  // ## Advanced Game Args ##
  parseAdv(id, msg);

  // ## Help Command Parser ##
  if(str === prefix + "HELP" || str.includes(`<@!${global.client.user.id}>`)) {
    commands.triviaHelp(msg, Database)
    .then((res) => {

      Trivia.send(msg.channel, msg.author, {embed: {
        color: Trivia.embedCol,
        description: res
      }});
    });
    return;
  }

  // ## Normal Commands ##
  // If the string starts with the specified prefix (converted to uppercase)
  if(str.startsWith(prefix)) {
    var cmd = str.replace(prefix, "");
    parseCommand(msg, cmd);
  }
};

// triviaResumeGame
// Restores a game that does not have an active timeout.
async function triviaResumeGame(json, id) {
  var channel;
  if(typeof json.userId !== "undefined") {
    // Find the DM channel
    channel = global.client.users.get(json.userId);

    // Re-create the dmChannel object.
    if(channel !== null) {
      channel.createDM()
      .then((dmChannel) => {
        channel = dmChannel;
      });
    }

  }
  else {
    channel = await global.client.channels.fetch(id);
  }

  if(!json.inProgress) {
    game.stopGame();
    return;
  }

  if(channel === null) {
    console.warn(`Unable to find channel '${id}' on shard ${global.client.shard.ids}. Game will not resume.`);
    game.stopGame();
    return;
  }

  json.resuming = 1;

  var date = game.date;
  var timeout;

  // If more than 60 seconds have passed, cancel the game entirely.
  if(new Date().getTime() > date.getTime()+60000) {
    console.log(`Imported game in channel ${id} is more than one minute old, aborting...`);
    game.stopGame();
    return;
  }

  if(json.inRound) {
    game = json;
    game.resuming = 1;

    // Calculate timeout based on game time

    date.setMilliseconds(date.getMilliseconds()+getConfigVal("round-length", channel));
    timeout = date-new Date();

    game.timeout = setTimeout(() => {
      Trivia.doAnswerReveal(game, channel, void 0, 1);
    }, timeout);
  }
  else {
    if(Object.keys(json.activeParticipants).length !== 0) {
      // Since date doesn't update between rounds, we'll have to add both the round's length and timeout
      date.setMilliseconds(date.getMilliseconds()+getConfigVal("round-timeout", channel)+getConfigVal("round-length", channel));
      timeout = date-new Date();

      game.timeout = setTimeout(() => {
        Trivia.doGame(id, channel, void 0, { category: json.category });
      }, timeout);
    }
  }
}

// Detect reaction answers
Trivia.reactionAdd = async function(reaction, user) {
  var id = reaction.message.channel.id;
  var game = Trivia.gameHandler.getActiveGame(id);
  var str = reaction.emoji.name;

  // If a game is in progress, the reaction is on the right message, the game uses reactions, and the reactor isn't the TriviaBot client...
  if(typeof game !== "undefined" && typeof game.message !== "undefined" && reaction.message.id === game.message.id && game.gameMode === 1 && user !== global.client.user) {
    if(str === "🇦") {
      str = "A";
    }
    else if(str === "🇧") {
      str = "B";
    }
    else if(str === "🇨") {
      str = "C";
    }
    else if(str === "🇩") {
      str = "D";
    }
    else {
      return; // The reaction isn't a letter, ignore it.
    }

    // Get the user's guild nickname, or regular name if in a DM.
    var msg = reaction.message;
    var username;

    if(msg.guild !== null) {
      // Fetch the guild member for this user.
      var guildMember = await msg.guild.members.fetch({user: user.id});
      username = guildMember.displayName;
    }
    else {
      username = user.username; 
    }

    Trivia.parseAnswer(game, str, id, user.id, username, getConfigVal("score-value", reaction.message.channel));
  }
};

// # Game Exporter #
// Export the current game data to a file.
Trivia.exportGame = (file) => {
  // Copy the data so we don't modify the actual game object.
  var json = JSON.parse(JSON.stringify(game));

  // Remove the timeout so the game can be exported.
  Object.keys(json).forEach((key) => {
    if(typeof json[key].timeout !== "undefined") {
      delete json[key].timeout;
      delete json[key].message;
    }

    // If there is no guild ID, the game is a DM game.
    // DM games are re-assigned to make sure they show up last.
    // This ensures that the first key is always a non-DM game if possible.
    if(typeof json[key].guildId === "undefined") {
      var replace = json[key];
      delete json[key];
      json[key] = replace;
    }

    // Never export a game if it has already been exported before.
    // This helps ensure that a restart loop won't happen.
    if(json[key].imported) {
      delete json[key];
    }
  });

  file = file || "./game."  + global.client.shard.ids + ".json.bak";
  try {
    fs.writeFileSync(file, JSON.stringify(json, null, "\t"), "utf8");
    console.log(`Game exported to ${file}`);
  }
  catch(err) {
    console.error(`Failed to write to game.json.bak with the following err:\n${err}`);
  }
};

// # Game Importer #
// Import game data from JSON files.
// input: file string or valid JSON object
// unlink (bool): delete file after opening
Trivia.importGame = (input, unlink) => {
  console.log(`Importing games to shard ${global.client.shard.ids} from file...`);
  var json;
  if(typeof input === "string") {
    try {
      var file = fs.readFileSync(input).toString();

      // If specified to do so, delete the file before parsing it.
      // This is to help prevent a restart loop if things go horribly wrong.
      if(unlink) {
        fs.unlinkSync(input);
      }

      json = JSON.parse(file);
    } catch(error) {
      console.log(`Failed to parse JSON from ./game.${global.client.shard.ids}.json.bak`);
      console.log(error.message);
      return;
    }
  }
  else if(typeof input === "object") {
    json = input;
  }
  else {
    throw new Error("Attempting to import an invalid or undefined object as a game!");
  }

  Object.keys(json).forEach((key) => {
    if(typeof game[key] === "undefined") {
      // Create a holder game object to complete what is left of the timeout.
      game[key] = json[key];

      // Mark it as imported so the exporter doesn't re-export it
      game[key].imported = 1;

      json[key].date = new Date(json[key].date);
      triviaResumeGame(json[key], key);
    }
  });
};

// # Maintenance Shutdown Command #
Trivia.doMaintenanceShutdown = () => {
  console.log(`Clearing ${Object.keys(game).length} games on shard ${global.client.shard.ids}`);

  Object.keys(this.gameHandler.activeGames).forEach((key) => {
    var channel = game.message.channel;
    Trivia.stopGame(key, 1);

    Trivia.send(channel, void 0, {embed: {
      color: Trivia.embedCol,
      description: "TriviaBot is being temporarily shut down for maintenance. Please try again in a few minutes."
    }});
  });

  return;
};

// # Fallback Mode Functionality #
if(getConfigVal("fallback-mode") && !getConfigVal("fallback-silent")) {
  global.client.on("message", (msg) => {
      console.log(`Msg - ${msg.author === global.client.user?"(self)":""} Shard ${global.client.shard.ids} - Channel ${msg.channel.id}`);
  });
}

process.on("exit", (code) => {
  if(code !== 0) {
    console.log("Exit with non-zero code, exporting game data...");
    Trivia.exportGame();
  }
});

process.on("SIGTERM", function() {
  console.log("Exit with termination signal, exporting game data...");
  Trivia.exportGame();
  process.exit();
});

// ## Import on Launch ## //
global.client.on("ready", () => {
  var file = `./game.${global.client.shard.ids}.json.bak`;
  if(fs.existsSync(file)) {
    // Import the file, then delete it.
    Trivia.importGame(file, 1);
  }
});
