import * as voice from '@discordjs/voice';
import { Message, TextChannel, User } from "discord.js";
import { promisify } from "node:util";
import { bot } from "../index";
import { QueueOptions } from "../interfaces/QueueOptions";
import { config } from "../utils/config";
import { i18n } from "../utils/i18n";
import { canModifyQueue } from "../utils/queue";
import { Song } from "./Song";

const wait = promisify(setTimeout);

export class MusicQueue {
  public readonly message: Message;
  public readonly connection: voice.VoiceConnection;
  public readonly player: voice.AudioPlayer;
  public readonly textChannel: TextChannel;
  public readonly bot = bot;

  public resource: voice.AudioResource;
  public songs: Song[] = [];
  public volume = config.DEFAULT_VOLUME || 100;
  public loop = false;
  public muted = false;
  public waitTimeout: NodeJS.Timeout;
  private queueLock = false;
  private readyLock = false;

  public constructor(options: QueueOptions) {
    Object.assign(this, options);

    this.textChannel = options.message.channel as TextChannel;
    this.player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play } });
    this.connection.subscribe(this.player);

    this.connection.on("stateChange" as any, async (oldState: voice.VoiceConnectionState, newState: voice.VoiceConnectionState) => {
      if (newState.status === voice.VoiceConnectionStatus.Disconnected) {
        if (newState.reason === voice.VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
          try {
            this.stop();
          } catch (e) {
            console.log(e);
            this.stop();
          }
        } else if (this.connection.rejoinAttempts < 5) {
          await wait((this.connection.rejoinAttempts + 1) * 5_000);
          this.connection.rejoin();
        } else {
          this.connection.destroy();
        }
      } else if (
        !this.readyLock &&
        (newState.status === voice.VoiceConnectionStatus.Connecting || newState.status === voice.VoiceConnectionStatus.Signalling)
      ) {
        this.readyLock = true;
        try {
          await voice.entersState(this.connection, voice.VoiceConnectionStatus.Ready, 20_000);
        } catch {
          if (this.connection.state.status !== voice.VoiceConnectionStatus.Destroyed) {
            try {
              this.connection.destroy();
            } catch {}
          }
        } finally {
          this.readyLock = false;
        }
      }
    });

    this.player.on("stateChange" as any, async (oldState: voice.AudioPlayerState, newState: voice.AudioPlayerState) => {
      if (oldState.status !== voice.AudioPlayerStatus.Idle && newState.status === voice.AudioPlayerStatus.Idle) {
        if (this.loop && this.songs.length) {
          this.songs.push(this.songs.shift()!);
        } else {
          this.songs.shift();
        }

        if (this.songs.length || this.resource) this.processQueue();
      } else if (oldState.status === voice.AudioPlayerStatus.Buffering && newState.status === voice.AudioPlayerStatus.Playing) {
        this.sendPlayingMessage(newState);
      }
    });

    this.player.on("error", (error: any) => {
      console.error(error);
      if (this.loop && this.songs.length) {
        this.songs.push(this.songs.shift()!);
      } else {
        this.songs.shift();
      }
      this.processQueue();
    });
  }

  public enqueue(...songs: Song[]) {
    if (typeof this.waitTimeout !== "undefined") clearTimeout(this.waitTimeout);
    this.songs = this.songs.concat(songs);
    this.processQueue();
  }

  public stop() {
    this.loop = false;
    this.songs = [];
    this.player.stop();

    !config.PRUNING && this.textChannel.send(i18n.__("play.queueEnded")).catch(console.error);

  }

  public async processQueue(): Promise<void> {
    if (this.queueLock || this.player.state.status !== voice.AudioPlayerStatus.Idle) {
      return;
    }

    if (!this.songs.length) {
      return this.stop();
    }

    this.queueLock = true;

    const next = this.songs[0];

    try {
      const resource = await next.makeResource();

      this.resource = resource!;
      this.player.play(this.resource);
      this.resource.volume?.setVolumeLogarithmic(this.volume / 100);
    } catch (error) {
      console.error(error);

      return this.processQueue();
    } finally {
      this.queueLock = false;
    }
  }

  private async sendPlayingMessage(newState: any) {
    const song = (newState.resource as voice.AudioResource<Song>).metadata;

    let playingMessage: Message;

    try {
      playingMessage = await this.textChannel.send((newState.resource as voice.AudioResource<Song>).metadata.startMessage());

      await playingMessage.react("⏭");
      await playingMessage.react("⏯");
      await playingMessage.react("🔇");
      await playingMessage.react("🔉");
      await playingMessage.react("🔊");
      await playingMessage.react("🔁");
      await playingMessage.react("🔀");
      await playingMessage.react("⏹");
    } catch (error: any) {
      console.error(error);
      this.textChannel.send(error.message);
      return;
    }

    const filter = (reaction: any, user: User) => user.id !== this.textChannel.client.user!.id;

    const collector = playingMessage.createReactionCollector({
      filter,
      time: song.duration > 0 ? song.duration * 1000 : 600000
    });

    collector.on("collect", async (reaction, user) => {
      if (!this.songs) return;

      const member = await playingMessage.guild!.members.fetch(user);

      switch (reaction.emoji.name) {
        case "⏭":
          reaction.users.remove(user).catch(console.error);
          await this.bot.commands.get("skip")!.execute(this.message);
          break;

        case "⏯":
          reaction.users.remove(user).catch(console.error);
          if (this.player.state.status == voice.AudioPlayerStatus.Playing) {
            await this.bot.commands.get("pause")!.execute(this.message);
          } else {
            await this.bot.commands.get("resume")!.execute(this.message);
          }
          break;

        case "🔇":
          reaction.users.remove(user).catch(console.error);
          if (!canModifyQueue(member)) return i18n.__("common.errorNotChannel");
          this.muted = !this.muted;
          if (this.muted) {
            this.resource.volume?.setVolumeLogarithmic(0);
            this.textChannel.send(i18n.__mf("play.mutedSong", { author: user })).catch(console.error);
          } else {
            this.resource.volume?.setVolumeLogarithmic(this.volume / 100);
            this.textChannel.send(i18n.__mf("play.unmutedSong", { author: user })).catch(console.error);
          }
          break;

        case "🔉":
          reaction.users.remove(user).catch(console.error);
          if (this.volume == 0) return;
          if (!canModifyQueue(member)) return i18n.__("common.errorNotChannel");
          this.volume = Math.max(this.volume - 10, 0);
          this.resource.volume?.setVolumeLogarithmic(this.volume / 100);
          this.textChannel
            .send(i18n.__mf("play.decreasedVolume", { author: user, volume: this.volume }))
            .catch(console.error);
          break;

        case "🔊":
          reaction.users.remove(user).catch(console.error);
          if (this.volume == 100) return;
          if (!canModifyQueue(member)) return i18n.__("common.errorNotChannel");
          this.volume = Math.min(this.volume + 10, 100);
          this.resource.volume?.setVolumeLogarithmic(this.volume / 100);
          this.textChannel
            .send(i18n.__mf("play.increasedVolume", { author: user, volume: this.volume }))
            .catch(console.error);
          break;

        case "🔁":
          reaction.users.remove(user).catch(console.error);
          await this.bot.commands.get("loop")!.execute(this.message);
          break;

        case "🔀":
          reaction.users.remove(user).catch(console.error);
          await this.bot.commands.get("shuffle")!.execute(this.message);
          break;

        case "⏹":
          reaction.users.remove(user).catch(console.error);
          await this.bot.commands.get("stop")!.execute(this.message);
          collector.stop();
          break;

        default:
          reaction.users.remove(user).catch(console.error);
          break;
      }
    });

    collector.on("end", () => {
      playingMessage.reactions.removeAll().catch(console.error);

      if (config.PRUNING) {
        setTimeout(() => {
          playingMessage.delete().catch();
        }, 3000);
      }
    });
  }
}
