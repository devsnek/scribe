'use strict';

require('dotenv').config();

const util = require('util');
const discord = require('discord.js');
const speech = require('@google-cloud/speech');

const STREAMING_LIMIT = 290000;

const debug = util.debuglog('streams');

const speechClient = new speech.SpeechClient();
const client = new discord.Client({
  intents: ['GUILDS', 'GUILD_VOICE_STATES'],
});

function registerCommands(guild) {
  client.api.applications(client.user.id).guilds(guild.id).commands.put({
    data: [
      {
        name: 'start',
        description: 'Join the current voice channel and begin transcribing',
        version: '1',
      },
      {
        name: 'stop',
        description: 'Stop transcribing and leave the current voice channel',
        version: '1',
      },
    ],
  });
}

client.on('ready', () => {
  console.log('Ready as', client.user.tag);
  client.guilds.cache.forEach((g) => {
    registerCommands(g);
  });
});

client.on('guildCreate', (guild) => {
  registerCommands(guild);
});

const CHANNELS = new Map();

class UserState {
  constructor(channelState, member) {
    this.channelState = channelState;
    this.member = member;
    this.recognizeStream = undefined;
    this.recognizeInterval = undefined;

    const userStream = channelState.connection.receiver.createStream(member.user, {
      mode: 'pcm',
      end: 'manual',
    });
    this.stream = userStream;
  }

  createRecognizeStream() {
    debug(this.member.displayName, 'CREATE STREAM');

    const recognizeStream = speechClient.streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        audioChannelCount: 2,
        sampleRateHertz: 48000,
        enableAutomaticPunctuation: true,
        languageCode: process.env.SPEECH_LANG || 'en-US',
        model: process.env.GOOGLE_SPEECH_MODEL || 'default',
        useEnhanced: !!process.env.GOOGLE_SPEECH_USE_ENHANCED_MODEL,
        streamingLimit: STREAMING_LIMIT,
        speechContexts: [{
          phrases: [
            'cuz',
            'naw',
            '200s',
            '400s',
            '401s',
            '403s',
            '500s',
            'IDs',
          ],
        }],
      },
      interimResults: true,
    });

    recognizeStream.on('data', ({ error, results }) => {
      if (error) {
        console.error(error);
        return;
      }
      if (results && results[0].isFinal) {
        const text = results[0].alternatives[0].transcript;
        if (text) {
          this.channelState.webhook.send(text, {
            username: this.member.displayName,
            avatarURL: this.member.user.displayAvatarURL(),
          });
        }
      }
    });

    return recognizeStream;
  }

  stopRecognizeStream(clear = true) {
    if (!this.recognizeStream) {
      return;
    }
    debug(this.member.displayName, 'DESTROY STREAM');
    if (clear) {
      clearInterval(this.recognizeInterval);
    }
    if (this.recognizeStream) {
      if (this.stream) {
        this.stream.unpipe(this.recognizeStream);
      }
      this.recognizeStream.end();
    }
    this.recognizeStream = undefined;
  }

  start() {
    if (this.recognizeStream) {
      return;
    }
    this.recognizeStream = this.createRecognizeStream();
    this.stream.pipe(this.recognizeStream);
    this.recognizeInterval = setInterval(() => {
      this.stopRecognizeStream(false);
      this.recognizeStream = this.createRecognizeStream();
      this.stream.pipe(this.recognizeStream);
    }, STREAMING_LIMIT);
  }

  stop() {
    this.stopRecognizeStream();
  }

  close() {
    try {
      this.stopRecognizeStream();
    } catch {
      // noop
    }
    try {
      this.stream.end();
    } catch {
      // noop
    }
  }
}

class ChannelState {
  constructor(connection, webhook) {
    this.connection = connection;
    this.webhook = webhook;
    this.channelID = this.connection.channel.id;
    this.states = new Map();

    this.connection.on('disconnect', () => {
      CHANNELS.delete(this.channelID);
      this.close();
    });

    this.connection.on('speaking', (user, speaking) => {
      if (!this.states.has(user.id)) {
        const member = this.connection.channel.guild.members.cache.get(user.id);
        this.states.set(user.id, new UserState(this, member));
      }
      const userState = this.states.get(user.id);
      if (speaking.bitfield !== 0) {
        userState.start();
      } else {
        userState.stop();
      }
    });
  }

  remove(user) {
    if (this.states.has(user.id)) {
      const s = this.states.get(user.id);
      this.states.delete(user.id);
      s.close();
    }
    if (this.states.size === 0) {
      this.close();
    }
  }

  close() {
    this.webhook.delete('Transcription completed');
    this.states.forEach((s) => {
      s.close();
    });
    if (this.connection.status !== 4) {
      this.connection.disconnect();
    }
  }
}

client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.channelID === newState.channelID) {
    return;
  }
  if (oldState.channelID) {
    const state = CHANNELS.get(oldState.channelID);
    if (state) {
      state.remove(oldState.member.user);
    }
  }
});

client.ws.on('INTERACTION_CREATE', (interaction) => {
  if (interaction.type !== 2) {
    return;
  }

  client.api.interactions(interaction.id, interaction.token).callback.post({
    data: {
      type: 5,
      data: {
        flags: 1 << 6,
      },
    },
  });

  const hook = new discord.WebhookClient(client.user.id, interaction.token);

  (async () => {
    const guild = client.guilds.cache.get(interaction.guild_id);
    const member = guild.members.cache.get(interaction.member.user.id);

    switch (interaction.data.name) {
      case 'start': {
        if (!member || !member.voice) {
          throw new Error('Please join a voice channel');
        }
        if (!CHANNELS.has(member.voice.channel.id)) {
          const webhook = await guild.channels.cache.get(interaction.channel_id)
            .createWebhook('Scribe', {
              reason: `Transcription of ${member.voice.channel.name}`,
            });
          const connection = await member.voice.channel.join();
          const state = new ChannelState(connection, webhook);
          CHANNELS.set(member.voice.channel.id, state);
          connection.setSpeaking(0);
        }
        break;
      }
      case 'stop': {
        const state = CHANNELS.get(member.voice.channel.id);
        state.close();
        break;
      }
      default:
        break;
    }
  })()
    .then(
      (v) => {
        hook.send({
          content: v || '\u{2705}',
          flags: 1 << 6,
        });
      },
      (e) => {
        hook.send({
          content: `\u{274C} ${e.message.split('\n')[0]}`,
          flags: 1 << 6,
        });
      },
    );
});

process.on('uncaughtException', (e) => {
  console.error(e);
});

process.on('unhandledRejection', (e) => {
  console.error(e);
});

client.login(process.env.DISCORD_TOKEN);
