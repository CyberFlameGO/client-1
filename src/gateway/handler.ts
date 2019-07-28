import { Constants as RestConstants } from 'detritus-client-rest';
import { Constants as SocketConstants } from 'detritus-client-socket';

const {
  GatewayDispatchEvents,
  GatewayOpCodes,
} = SocketConstants;

import { ShardClient } from '../client';
import { BaseCollection } from '../collections/basecollection';
import { ClientEvents } from '../constants';
import { GatewayHTTPError } from '../errors';

import {
  DEFAULT_PRESENCE_CACHE_KEY,
} from '../collections';

import {
  createChannelFromData,
  Channel,
  ChannelDM,
  Emoji,
  Guild,
  Member,
  Message,
  Presence,
  Reaction,
  Relationship,
  Role,
  Typing,
  User,
  UserMe,
  VoiceCall,
  VoiceState,
} from '../structures';

import * as Types from './types';


export interface GatewayHandlerOptions {
  disabledEvents?: Array<string>,
  emitRawEvent?: boolean,
  loadAllMembers?: boolean,
}

export interface GatewayHandlerPayload {
  data: any,
  name: string,
}


/**
 * Gateway Handler
 * @category Handler
 */
export class GatewayHandler {
  client: ShardClient;
  disabledEvents: Set<string>;
  dispatchHandler: GatewayDispatchHandler;
  emitRawEvent: boolean;
  loadAllMembers: boolean;
  memberChunksLeft: Set<string>;

  constructor(
    client: ShardClient,
    options: GatewayHandlerOptions = {},
  ) {
    this.client = client;
    this.client.gateway.on('packet', this.onPacket.bind(this));

    this.emitRawEvent = !!options.emitRawEvent;
    this.dispatchHandler = new GatewayDispatchHandler(this);
    this.disabledEvents = new Set((options.disabledEvents || []).map((v) => {
      return v.toUpperCase();
    }));
    this.loadAllMembers = !!options.loadAllMembers;
    this.memberChunksLeft = new Set();
  }

  get shouldLoadAllMembers(): boolean {
    return this.loadAllMembers && this.client.gateway.guildSubscriptions;
  }

  onPacket(packet: Types.GatewayPacket): void {
    if (packet.op !== GatewayOpCodes.DISPATCH) {
      return;
    }

    const payload: GatewayHandlerPayload = {name: packet.t, data: packet.d};
    if (this.emitRawEvent) {
      this.client.emit(ClientEvents.RAW_EVENT, payload);
    }
    if (!this.disabledEvents.has(payload.name)) {
      const handler = this.dispatchHandler.getHandler(payload.name);
      if (handler !== undefined) {
        handler.call(this.dispatchHandler, payload.data);
      } else {
        this.client.emit(ClientEvents.UNKNOWN, payload);
        this.client.emit(payload.name, payload.data);
      }
    }
  }
}


/**
 * Gateway Dispatch Handler Function
 * @category Handlers
 */
export type GatewayDispatchHandlerFunction = (data: any) => void;


/**
 * Gateway Dispatch Handler
 * @category Handlers
 */
export class GatewayDispatchHandler {
  handler: GatewayHandler;

  constructor(handler: GatewayHandler) {
    this.handler = handler;
  }

  get client() {
    return this.handler.client;
  }

  getHandler(name: string): GatewayDispatchHandlerFunction | undefined {
    return (<any> this)[name];
  }

  /* Dispatch Events */
  async [GatewayDispatchEvents.READY](data: Types.Ready) {
    this.client.reset();

    if (this.client.user === null) {
      this.client.user = new UserMe(this.client, data['user']);
    } else {
      this.client.user.merge(data['user']);
    }
    this.client.users.insert(this.client.user); // since we reset the cache

    Object.defineProperty(this.client, '_isBot', {value: data['user']['bot']});
    this.client.rest.setAuthType((this.client.isBot) ? RestConstants.AuthTypes.BOT : RestConstants.AuthTypes.USER);

    if (this.client.channels.enabled) {
      if (data['private_channels']) {
        for (let raw of data['private_channels']) {
          if (this.client.channels.has(raw.id)) {
            (<Channel> this.client.channels.get(raw.id)).merge(raw);
          } else {
            this.client.channels.insert(createChannelFromData(this.client, raw));
          }
        }
      }
    }

    if (this.client.guilds.enabled) {
      for (let raw of data['guilds']) {
        let guild: Guild;
        if (this.client.guilds.has(raw.id)) {
          guild = <Guild> this.client.guilds.get(raw.id);
          guild.merge(raw);
        } else {
          guild = new Guild(this.client, raw);
          this.client.guilds.insert(guild);
        }
        if (this.handler.shouldLoadAllMembers) {
          if (guild.unavailable) {
            this.handler.memberChunksLeft.add(guild.id);
          } else {
            if (this.handler.memberChunksLeft.has(guild.id)) {
              if (this.client.gateway.largeThreshold < guild.memberCount) {
                this.client.gateway.requestGuildMembers(guild.id, {
                  limit: 0,
                  presences: true,
                  query: '',
                });
              }
              this.handler.memberChunksLeft.delete(guild.id);
            }
          }
        }
      }
    }

    if (this.client.notes.enabled && data['notes']) {
      for (let userId in data['notes']) {
        this.client.notes.insert(userId, data['notes'][userId]);
      }
    }

    if (this.client.presences.enabled && data['presences']) {
      for (let raw of data['presences']) {
        this.client.presences.add(raw);
      }
    }

    if (this.client.relationships.enabled && data['relationships']) {
      for (let raw of data['relationships']) {
        if (this.client.relationships.has(raw.id)) {
          (<Relationship> this.client.relationships.get(raw.id)).merge(raw);
        } else {
          this.client.relationships.insert(new Relationship(this.client, raw));
        }
      }
    }

    if (this.client.sessions.enabled && data['sessions']) {
      for (let raw of data['sessions']) {

      }
    }

    if (data['user_settings']) {

    }

    this.client.gateway.discordTrace = data['_trace'];
    this.client.emit(ClientEvents.GATEWAY_READY, {raw: data});

    if (this.client.isBot) {
      try {
        await this.client.rest.fetchOauth2Application();
      } catch(error) {
        this.client.emit('warn', new GatewayHTTPError('Failed to fetch OAuth2 Application Information', error));
      }
    } else {
      this.client.owners.set(this.client.user.id, this.client.user);
    }
  }

  [GatewayDispatchEvents.RESUMED](data: Types.Resumed) {
    this.client.gateway.discordTrace = data['_trace'];
    this.client.emit(ClientEvents.GATEWAY_RESUMED, {raw: data});
  }

  [GatewayDispatchEvents.ACTIVITY_JOIN_INVITE](data: Types.ActivityJoinInvite) {

  }

  [GatewayDispatchEvents.ACTIVITY_JOIN_REQUEST](data: Types.ActivityJoinRequest) {

  }

  [GatewayDispatchEvents.ACTIVITY_START](data: Types.ActivityStart) {

  }

  [GatewayDispatchEvents.BRAINTREE_POPUP_BRIDGE_CALLBACK](data: Types.BraintreePopupBridgeCallback) {

  }

  [GatewayDispatchEvents.CALL_CREATE](data: Types.CallCreate) {
    let call: VoiceCall;
    if (this.client.voiceCalls.has(data['channel_id'])) {
      call = <VoiceCall> this.client.voiceCalls.get(data['channel_id']);
      call.merge(data);
    } else {
      call = new VoiceCall(this.client, data);
      this.client.voiceCalls.insert(call);
    }
    this.client.emit(ClientEvents.CALL_CREATE, {call});
  }

  [GatewayDispatchEvents.CALL_DELETE](data: Types.CallDelete) {
    if (this.client.voiceCalls.has(data['channel_id'])) {
      const call = <VoiceCall> this.client.voiceCalls.get(data['channel_id']);
      call.kill();
    }
    this.client.emit(ClientEvents.CALL_DELETE, {channelId: data['channel_id']});
  }

  [GatewayDispatchEvents.CALL_UPDATE](data: Types.CallUpdate) {
    let call: VoiceCall;
    let differences: any = null;
    if (this.client.voiceCalls.has(data['channel_id'])) {
      call = <VoiceCall> this.client.voiceCalls.get(data['channel_id']);
      if (this.client.hasEventListener(ClientEvents.CALL_UPDATE)) {
        differences = call.differences(data);
      }
      call.merge(data);
    } else {
      call = new VoiceCall(this.client, data);
      this.client.voiceCalls.insert(call);
    }
    this.client.emit(ClientEvents.CALL_UPDATE, {call, differences});
  }

  [GatewayDispatchEvents.CHANNEL_CREATE](data: Types.ChannelCreate) {
    let channel: Channel;
    if (this.client.channels.has(data['id'])) {
      channel = <Channel> this.client.channels.get(data['id']);
      channel.merge(data);
    } else {
      channel = createChannelFromData(this.client, data);
      this.client.channels.insert(channel);
    }
    this.client.emit(ClientEvents.CHANNEL_CREATE, {channel});
  }

  [GatewayDispatchEvents.CHANNEL_DELETE](data: Types.ChannelDelete) {
    let channel: Channel;
    if (this.client.channels.has(data['id'])) {
      channel = <Channel> this.client.channels.get(data['id']);
      this.client.channels.delete(data['id']);
    } else {
      channel = createChannelFromData(this.client, data);
    }
    this.client.emit(ClientEvents.CHANNEL_DELETE, {channel});
  }

  [GatewayDispatchEvents.CHANNEL_PINS_ACK](data: Types.ChannelPinsAck) {

  }

  [GatewayDispatchEvents.CHANNEL_PINS_UPDATE](data: Types.ChannelPinsUpdate) {
    let channel: Channel | null = null;
    if (this.client.channels.has(data['channel_id'])) {
      channel = <Channel> this.client.channels.get(data['channel_id']);
      channel.merge({
        last_pin_timestamp: data['last_pin_timestamp'],
      });
    }
    this.client.emit(ClientEvents.CHANNEL_DELETE, {
      channel,
      channelId: data['channel_id'],
      guildId: data['guild_id'],
      lastPinTimestamp: data['last_pin_timestamp'],
    });
  }

  [GatewayDispatchEvents.CHANNEL_UPDATE](data: Types.ChannelUpdate) {
    let channel: Channel;
    let differences: any = null;
    if (this.client.channels.has(data['id'])) {
      channel = <Channel> this.client.channels.get(data['id']);
      if (this.client.hasEventListener(ClientEvents.CHANNEL_UPDATE)) {
        differences = channel.differences(data);
      }
      channel.merge(data);
    } else {
      channel = createChannelFromData(this.client, data);
      this.client.channels.insert(channel);
    }
    this.client.emit(ClientEvents.CHANNEL_UPDATE, {channel, differences});
  }

  [GatewayDispatchEvents.CHANNEL_RECIPIENT_ADD](data: Types.ChannelRecipientAdd) {
    let channel: ChannelDM | null = null;
    const channelId = data['channel_id'];
    const nick = data['nick'];
    let user: User;

    if (this.client.channels.has(channelId)) {
      channel = <ChannelDM> this.client.channels.get(channelId);
      if (channel.recipients.has(data['user']['id'])) {
        user = <User> channel.recipients.get(data['user']['id']);
        user.merge(data);
      } else {
        user = new User(this.client, data['user']);
        channel.recipients.set(user.id, user);
      }
      if (nick == null) {
        channel.nicks.delete(user.id);
      } else {
        channel.nicks.set(user.id, nick);
      }
    } else {
      user = new User(this.client, data['user']);
      this.client.users.insert(user);
    }

    this.client.emit(ClientEvents.CHANNEL_RECIPIENT_ADD, {
      channel,
      channelId,
      nick,
      user,
    });
  }

  [GatewayDispatchEvents.CHANNEL_RECIPIENT_REMOVE](data: Types.ChannelRecipientRemove) {
    let channel: ChannelDM | null = null;
    const channelId = data['channel_id'];
    const nick = data['nick'];
    let user: User;

    if (this.client.channels.has(channelId)) {
      channel = <ChannelDM> this.client.channels.get(channelId);
      if (channel.recipients.has(data['user']['id'])) {
        user = <User> channel.recipients.get(data['user']['id']);
        user.merge(data);
        channel.recipients.delete(user.id);
      } else {
        user = new User(this.client, data['user']);
      }
    } else {
      user = new User(this.client, data['user']);
    }

    this.client.emit(ClientEvents.CHANNEL_RECIPIENT_REMOVE, {
      channel,
      channelId,
      nick,
      user,
    });
  }

  [GatewayDispatchEvents.ENTITLEMENT_CREATE](data: Types.EntitlementCreate) {

  }

  [GatewayDispatchEvents.ENTITLEMENT_DELETE](data: Types.EntitlementDelete) {

  }

  [GatewayDispatchEvents.ENTITLEMENT_UPDATE](data: Types.EntitlementUpdate) {

  }

  [GatewayDispatchEvents.FRIEND_SUGGESTION_CREATE](data: Types.FriendSuggestionCreate) {
    this.client.emit(ClientEvents.FRIEND_SUGGESTION_CREATE, {
      reasons: data.reasons.map((reason: any) => {
        return {name: reason['name'], platformType: reason['platform_type']};
      }),
      user: new User(this.client, data['suggested_user']),
    });
  }

  [GatewayDispatchEvents.FRIEND_SUGGESTION_DELETE](data: Types.FriendSuggestionDelete) {
    this.client.emit(ClientEvents.FRIEND_SUGGESTION_DELETE, {
      suggestedUserId: data['suggested_user_id'],
    });
  }

  [GatewayDispatchEvents.GIFT_CODE_UPDATE](data: Types.GiftCodeUpdate) {
    this.client.emit(ClientEvents.GIFT_CODE_UPDATE, {
      code: data['code'],
      uses: data['uses'],
    });
  }

  [GatewayDispatchEvents.GUILD_BAN_ADD](data: Types.GuildBanAdd) {
    const guild = this.client.users.get(data['guild_id']);
    const guildId = data['guild_id'];
    let user: User;

    if (this.client.users.has(data['user']['id'])) {
      user = <User> this.client.users.get(data['user']['id']);
      user.merge(data['user']);
    } else {
      user = new User(this.client, data['user']);
    }

    this.client.emit(ClientEvents.GUILD_BAN_ADD, {
      guild,
      guildId,
      user,
    });
  }

  [GatewayDispatchEvents.GUILD_BAN_REMOVE](data: Types.GuildBanRemove) {
    const guild = this.client.users.get(data['guild_id']);
    const guildId = data['guild_id'];
    let user: User;

    if (this.client.users.has(data['user']['id'])) {
      user = <User> this.client.users.get(data['user']['id']);
      user.merge(data['user']);
    } else {
      user = new User(this.client, data['user'])
    }

    this.client.emit(ClientEvents.GUILD_BAN_REMOVE, {
      guild,
      guildId,
      user,
    });
  }

  [GatewayDispatchEvents.GUILD_CREATE](data: Types.GuildCreate) {
    let fromUnavailable = false;
    let guild: Guild;

    if (this.client.guilds.has(data['id'])) {
      guild = <Guild> this.client.guilds.get(data['id']);
      fromUnavailable = guild.unavailable;
      guild.merge(data);
    } else {
      guild = new Guild(this.client, data);
      this.client.guilds.insert(guild);
      if (this.handler.shouldLoadAllMembers) {
        this.handler.memberChunksLeft.add(guild.id);
      }
    }

    if (this.handler.memberChunksLeft.has(guild.id)) {
      if (this.handler.loadAllMembers) {
        if (this.client.gateway.largeThreshold < guild.memberCount) {
          this.client.gateway.requestGuildMembers(guild.id, {
            limit: 0,
            presences: true,
            query: '',
          });
        }
      }
      this.handler.memberChunksLeft.delete(data.id);
    }

    this.client.emit(ClientEvents.GUILD_CREATE, {
      fromUnavailable,
      guild,
    });
  }

  [GatewayDispatchEvents.GUILD_DELETE](data: Types.GuildDelete) {
    let guild: Guild | null = null;
    const guildId = data['id'];
    const isUnavailable = !!data['unavailable'];

    if (isUnavailable) {
      if (this.client.guilds.has(data['id'])) {
        guild = <Guild> this.client.guilds.get(data['id']);
        guild.merge(data);
      } else {
        guild = new Guild(this.client, data);
        this.client.guilds.insert(guild);
      }
    } else {
      this.client.guilds.delete(data['id']);
      this.client.members.delete(data['id']);
      this.client.presences.delete(data['id']);
      this.client.emojis.forEach((emoji: Emoji) => {
        if (emoji.guildId === data['id']) {
          this.client.emojis.delete(emoji.id);
        }
      });
    }
  
    this.client.emit(ClientEvents.GUILD_DELETE, {
      guild,
      guildId,
      isUnavailable,
    });
  }

  [GatewayDispatchEvents.GUILD_EMOJIS_UPDATE](data: Types.GuildEmojisUpdate) {
    let emojis: BaseCollection<string, Emoji>;
    let emojisOld: BaseCollection<string, Emoji> | null = null;
    let guild: null | Guild = null;
    const guildId = data['guild_id'];

    if (this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
      if (this.client.hasEventListener(ClientEvents.GUILD_EMOJIS_UPDATE)) {
        emojisOld = guild.emojis;
      }
      guild.merge({emojis: data['emojis']});
      emojis = guild.emojis;
    } else {
      emojisOld = new BaseCollection(this.client.emojis.filter((emoji: Emoji) => {
        return emoji.guildId === guildId;
      }));
      for (let [id, emoji] of emojisOld) {
        if (!data['emojis'].some((e) => e.id === id)) {
          this.client.emojis.delete(id);
        }
      }
      emojis = new BaseCollection();
      for (let raw of data['emojis']) {
        const emojiId = <string> raw.id;
        let emoji: Emoji;
        if (this.client.emojis.has(emojiId)) {
          emoji = <Emoji> this.client.emojis.get(emojiId);
          emoji.merge(raw);
        } else {
          emoji = new Emoji(this.client, raw);
          emoji.guildId = guildId;
          this.client.emojis.insert(emoji);
        }
        emojis.set(emoji.id, emoji);
      }
    }

    this.client.emit(ClientEvents.GUILD_EMOJIS_UPDATE, {
      emojis,
      emojisOld,
      guild,
      guildId,
    });
  }

  [GatewayDispatchEvents.GUILD_INTEGRATIONS_UPDATE](data: Types.GuildIntegrationsUpdate) {
    this.client.emit(ClientEvents.GUILD_INTEGRATIONS_UPDATE, {
      guildId: data['guild_id'],
    });
  }

  [GatewayDispatchEvents.GUILD_MEMBER_ADD](data: Types.GuildMemberAdd) {
    const guildId = data['guild_id'];
    let member: Member;

    if (this.client.members.has(guildId, data['user']['id'])) {
      member = <Member> this.client.members.get(guildId, data['user']['id']);
      member.merge(data);
    } else {
      member = new Member(this.client, data);
      this.client.members.insert(member);
    }

    if (this.client.guilds.has(guildId)) {
      const guild = <Guild> this.client.guilds.get(guildId);
      guild.merge({
        member_count: guild.memberCount + 1,
      });
    }

    this.client.emit(ClientEvents.GUILD_MEMBER_ADD, {
      guildId,
      member,
    });
  }

  [GatewayDispatchEvents.GUILD_MEMBER_LIST_UPDATE](data: Types.GuildMemberListUpdate) {
    this.client.emit(ClientEvents.GUILD_MEMBER_LIST_UPDATE, {
      raw: data,
    });
  }

  [GatewayDispatchEvents.GUILD_MEMBER_REMOVE](data: Types.GuildMemberRemove) {
    const guildId = data['guild_id'];
    let user: User;

    if (this.client.members.has(guildId, data['user']['id'])) {
      this.client.members.delete(guildId, data['user']['id']);
    }

    if (this.client.users.has(data['user']['id'])) {
      user = <User> this.client.users.get(data['user']['id']);
      user.merge(data['user']);
    } else {
      user = new User(this.client, data['user']);
    }

    if (this.client.guilds.has(guildId)) {
      const guild = <Guild> this.client.guilds.get(guildId);
      guild.merge({
        member_count: guild.memberCount - 1,
      });
    }

    this.client.emit(ClientEvents.GUILD_MEMBER_REMOVE, {
      guildId,
      user,
    });
  }

  [GatewayDispatchEvents.GUILD_MEMBER_UPDATE](data: Types.GuildMemberUpdate) {
    let differences: any = null;
    const guildId = data['guild_id'];
    let member: Member;

    if (this.client.members.has(guildId, data['user']['id'])) {
      member = <Member> this.client.members.get(guildId, data['user']['id']);
      if (this.client.hasEventListener(ClientEvents.GUILD_MEMBER_UPDATE)) {
        differences = member.differences(data);
      }
      member.merge(data);
    } else {
      member = new Member(this.client, data);
      this.client.members.insert(member);
    }

    this.client.emit(ClientEvents.GUILD_MEMBER_UPDATE, {
      differences,
      guildId,
      member,
    });
  }

  [GatewayDispatchEvents.GUILD_MEMBERS_CHUNK](data: Types.GuildMembersChunk) {
    const amounts: {
      members?: number,
      notFound?: number,
      presences?: number,
    } = {};
    const guildId = data['guild_id'];

    if (data['members'] !== undefined) {
      amounts.members = data['members'].length;
      if (this.client.members.enabled) {
        for (let value of data['members']) {
          const user = <Types.RawUser> value.user;
          if (this.client.members.has(guildId, user.id)) {
            (<Member> this.client.members.get(guildId, user.id)).merge(value);
          } else {
            const member = new Member(this.client, value);
            member.guildId = guildId;
            this.client.members.insert(member);
          }
        }
      } else if (this.client.users.enabled) {
        for (let value of data['members']) {
          const user = <Types.RawUser> value.user;
          if (this.client.users.has(user.id)) {
            (<User> this.client.users.get(user.id)).merge(user);
          } else {
            this.client.users.insert(new User(this.client, user));
          }
        }
      }
    }

    if (data['not_found'] !== undefined) {
      amounts.notFound = data['not_found'].length;
    }

    if (data['presences'] !== undefined) {
      amounts.presences = data['presences'].length;
      if (this.client.presences.enabled) {
        for (let value of data['presences']) {
          value.guild_id = guildId;
          this.client.presences.add(value);
        }
      }
    }

    this.client.emit(ClientEvents.GUILD_MEMBERS_CHUNK, {
      amounts,
      guildId,
      raw: data,
    });
  }

  [GatewayDispatchEvents.GUILD_ROLE_CREATE](data: Types.GuildRoleCreate) {
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let role: Role;

    if (this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
      if (guild.roles.has(data['role']['id'])) {
        role = <Role> guild.roles.get(data['role']['id']);
        role.merge(data['role']);
      } else {
        data['role']['guild_id'] = guildId;
        role = new Role(this.client, data['role']);
      }
    } else {
      data['role']['guild_id'] = guildId;
      role = new Role(this.client, data['role']);
    }

    this.client.emit(ClientEvents.GUILD_ROLE_CREATE, {
      guild,
      guildId,
      role,
    });
  }

  [GatewayDispatchEvents.GUILD_ROLE_DELETE](data: Types.GuildRoleDelete) {
    let guild: null | Guild = null;
    const guildId = data['guild_id'];
    let role: null | Role = null;
    const roleId = data['role_id'];

    if (this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
      if (guild.roles.has(roleId)) {
        role = <Role> guild.roles.get(roleId);
        guild.roles.delete(roleId);
      }
    }

    this.client.emit(ClientEvents.GUILD_ROLE_DELETE, {
      guild,
      guildId,
      role,
      roleId,
    });
  }

  [GatewayDispatchEvents.GUILD_ROLE_UPDATE](data: Types.GuildRoleUpdate) {
    let differences: any = null;
    let guild: null | Guild = null;
    const guildId = data['guild_id'];
    let role: Role;

    if (this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
      if (guild.roles.has(data['role']['id'])) {
        role = <Role> guild.roles.get(data['role']['id']);
        if (this.client.hasEventListener(ClientEvents.GUILD_ROLE_UPDATE)) {
          differences = role.differences(data['role']);
        }
        role.merge(data['role']);
      } else {
        data['role']['guild_id'] = guildId;
        role = new Role(this.client, data['role']);
        guild.roles.set(role.id, role);
      }
    } else {
      data['role']['guild_id'] = guildId;
      role = new Role(this.client, data['role']);
    }

    this.client.emit(ClientEvents.GUILD_ROLE_UPDATE, {
      differences,
      guild,
      guildId,
      role,
    });
  }

  [GatewayDispatchEvents.GUILD_UPDATE](data: Types.GuildUpdate) {
    let differences: any = null;
    let guild: Guild;

    if (this.client.guilds.has(data['id'])) {
      guild = <Guild> this.client.guilds.get(data['id']);
      if (this.client.hasEventListener(ClientEvents.GUILD_UPDATE)) {
        differences = guild.differences(data);
      }
      guild.merge(data);
    } else {
      guild = new Guild(this.client, data);
      this.client.guilds.insert(guild);
    }

    this.client.emit(ClientEvents.GUILD_UPDATE, {
      differences,
      guild,
    });
  }

  [GatewayDispatchEvents.LIBRARY_APPLICATION_UPDATE](data: Types.LibraryApplicationUpdate) {

  }

  [GatewayDispatchEvents.LOBBY_CREATE](data: Types.LobbyCreate) {

  }

  [GatewayDispatchEvents.LOBBY_DELETE](data: Types.LobbyDelete) {

  }

  [GatewayDispatchEvents.LOBBY_UPDATE](data: Types.LobbyUpdate) {

  }

  [GatewayDispatchEvents.LOBBY_MEMBER_CONNECT](data: Types.LobbyMemberConnect) {

  }

  [GatewayDispatchEvents.LOBBY_MEMBER_DISCONNECT](data: Types.LobbyMemberDisconnect) {

  }

  [GatewayDispatchEvents.LOBBY_MEMBER_UPDATE](data: Types.LobbyMemberUpdate) {

  }

  [GatewayDispatchEvents.LOBBY_MESSAGE](data: Types.LobbyMessage) {

  }

  [GatewayDispatchEvents.LOBBY_VOICE_SERVER_UPDATE](data: Types.LobbyVoiceServerUpdate) {

  }

  [GatewayDispatchEvents.LOBBY_VOICE_STATE_UPDATE](data: Types.LobbyVoiceStateUpdate) {

  }

  [GatewayDispatchEvents.MESSAGE_ACK](data: Types.MessageAck) {

  }

  [GatewayDispatchEvents.MESSAGE_CREATE](data: Types.MessageCreate) {
    let message: Message;

    if (this.client.messages.has(data['id'])) {
      message = <Message> this.client.messages.get(data['id']);
      message.merge(data);
    } else {
      message = new Message(this.client, data);
      this.client.messages.insert(message);
    }

    if (this.client.channels.has(data['channel_id'])) {
      const channel = <Channel> this.client.channels.get(data['channel_id']);
      channel.merge({last_message_id: data['id']});
    }

    this.client.emit(ClientEvents.MESSAGE_CREATE, {
      message,
    });
  }

  [GatewayDispatchEvents.MESSAGE_DELETE](data: Types.MessageDelete) {
    let message: Message | null = null;

    if (this.client.messages.has(data['id'])) {
      message = <Message> this.client.messages.get(data['id']);
      this.client.messages.delete(data['id']);
    }

    this.client.emit(ClientEvents.MESSAGE_DELETE, {
      message,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_DELETE_BULK](data: Types.MessageDeleteBulk) {
    const amount = data['ids'].length;
    let channel: Channel | null = null;
    const channelId = data['channel_id'];
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    const messages = new BaseCollection<string, Message | null>();

    for (let messageId of data['ids']) {
      if (this.client.messages.has(messageId)) {
        messages.set(messageId, <Message> this.client.messages.get(messageId));
        this.client.messages.delete(messageId);
      } else {
        messages.set(messageId, null);
      }
    }

    if (this.client.channels.has(channelId)) {
      channel = <Channel> this.client.channels.get(channelId);
    }
    if (guildId !== undefined && this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
    }

    this.client.emit(ClientEvents.MESSAGE_DELETE_BULK, {
      amount,
      channel,
      channelId,
      guild,
      guildId,
      messages,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_REACTION_ADD](data: Types.MessageReactionAdd) {
    let channel: Channel | null = null;
    const channelId = data['channel_id'];
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let message: Message | null = null;
    const messageId = data['message_id'];
    let reaction: null | Reaction = null;
    let user: User | null = null;
    const userId = data['user_id'];

    if (this.client.users.has(userId)) {
      user = <User> this.client.users.get(userId);
    }

    const emojiId = data.emoji.id || data.emoji.name;
    if (this.client.messages.has(messageId)) {
      message = <Message> this.client.messages.get(messageId);
      if (message.reactions.has(emojiId)) {
        reaction = <Reaction> message.reactions.get(emojiId);
      }
    }

    if (reaction === null) {
      reaction = new Reaction(this.client, data);
      if (message) {
        message.reactions.set(emojiId, reaction);
      }
    }

    const meUserId = (this.client.user) ? this.client.user.id : null;
    reaction.merge({
      count: reaction.count + 1,
      me: (userId === meUserId) || reaction.me,
    });

    if (this.client.channels.has(channelId)) {
      channel = <Channel> this.client.channels.get(channelId);
    }
    if (guildId !== undefined && this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
    }

    this.client.emit(ClientEvents.MESSAGE_REACTION_ADD, {
      channel,
      channelId,
      guild,
      guildId,
      message,
      messageId,
      reaction,
      user,
      userId,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_REACTION_REMOVE](data: Types.MessageReactionRemove) {
    let channel: Channel | null = null;
    const channelId = data['channel_id'];
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let message: Message | null = null;
    const messageId = data['message_id'];
    let reaction: null | Reaction = null;
    let user: User | null = null;
    const userId = data['user_id'];

    if (this.client.users.has(userId)) {
      user = <User> this.client.users.get(userId);
    }

    const meUserId = (this.client.user) ? this.client.user.id : null;

    const emojiId = data.emoji.id || data.emoji.name;
    if (this.client.messages.has(messageId)) {
      message = <Message> this.client.messages.get(messageId);
      if (message.reactions.has(emojiId)) {
        reaction = <Reaction> message.reactions.get(emojiId);
        reaction.merge({
          count: Math.min(reaction.count - 1, 0),
          me: reaction.me && userId !== meUserId,
        });
        if (reaction.count <= 0) {
          message.reactions.delete(emojiId);
        }
      }
    }

    if (reaction === null) {
      reaction = new Reaction(this.client, data);
    }

    if (this.client.channels.has(channelId)) {
      channel = <Channel> this.client.channels.get(channelId);
    }
    if (guildId !== undefined && this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
    }

    this.client.emit(ClientEvents.MESSAGE_REACTION_REMOVE, {
      channel,
      channelId,
      guild,
      guildId,
      message,
      messageId,
      reaction,
      user,
      userId,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_REACTION_REMOVE_ALL](data: Types.MessageReactionRemoveAll) {
    let channel: Channel | null = null;
    const channelId = data['channel_id'];
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let message: Message | null = null;
    const messageId = data['message_id'];

    if (this.client.messages.has(messageId)) {
      message = <Message> this.client.messages.get(messageId);
      message.reactions.clear();
    }

    if (this.client.channels.has(channelId)) {
      channel = <Channel> this.client.channels.get(channelId);
    }
    if (guildId !== undefined && this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
    }

    this.client.emit(ClientEvents.MESSAGE_REACTION_REMOVE_ALL, {
      channel,
      channelId,
      guild,
      guildId,
      message,
      messageId,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_UPDATE](data: Types.MessageUpdate) {
    let differences: any;
    let message: Message;

    if (this.client.messages.has(data['id'])) {
      message = <Message> this.client.messages.get(data['id']);
      if (this.client.hasEventListener(ClientEvents.MESSAGE_UPDATE)) {
        differences = message.differences(data);
      }
      message.merge(data);
    } else {
      message = new Message(this.client, data);
      this.client.messages.insert(message);
    }

    this.client.emit(ClientEvents.MESSAGE_UPDATE, {
      differences,
      message,
    });
  }

  [GatewayDispatchEvents.OAUTH2_TOKEN_REVOKE](data: Types.Oauth2TokenRevoke) {

  }

  [GatewayDispatchEvents.PRESENCE_UPDATE](data: Types.PresenceUpdate) {
    let differences: any = null;
    let isGuildPresence = !!data['guild_id'];
    let member: Member | null = null;
    let presence: Presence;

    if (this.client.hasEventListener(ClientEvents.PRESENCE_UPDATE)) {
      const cacheId = data['guild_id'] || DEFAULT_PRESENCE_CACHE_KEY;
      if (this.client.presences.has(cacheId, data['user']['id'])) {
        differences = (<Presence> this.client.presences.get(cacheId, data['user']['id'])).differences(data);
      }
    }
    presence = this.client.presences.add(data);

    if (data['guild_id']) {
      const rawMember = {
        guild_id: data['guild_id'],
        nick: data['nick'],
        premium_since: data['premium_since'],
        roles: data['roles'] || [],
        user: data['user'],
      };
      if (this.client.members.has(data['guild_id'], data['user']['id'])) {
        member = <Member> this.client.members.get(data['guild_id'], data['user']['id']);
        member.merge(rawMember);
      } else {
        member = new Member(this.client, rawMember);
        this.client.members.insert(member);
      }
    }

    this.client.emit(ClientEvents.PRESENCE_UPDATE, {
      differences,
      isGuildPresence,
      member,
      presence,
      guildId: data['guild_id'],
    });
  }

  [GatewayDispatchEvents.PRESENCES_REPLACE](data: Types.PresencesReplace) {
    const presences = new BaseCollection<string, Presence>();

    if (data['presences'] != null) {
      for (let raw of data['presences']) {
        // guildId is empty, use default presence cache id
        const presence = this.client.presences.add(raw);
        presences.set(presence.user.id, presence);
      }
    }

    this.client.emit(ClientEvents.PRESENCES_REPLACE, {
      presences,
    });
  }

  [GatewayDispatchEvents.RECENT_MENTION_DELETE](data: Types.RecentMentionDelete) {

  }

  [GatewayDispatchEvents.RELATIONSHIP_ADD](data: Types.RelationshipAdd) {
    let differences: any;
    let relationship: Relationship;

    if (this.client.relationships.has(data['id'])) {
      relationship = <Relationship> this.client.relationships.get(data['id']);
      if (this.client.hasEventListener(ClientEvents.RELATIONSHIP_ADD)) {
        differences = relationship.differences(data);
      }
      relationship.merge(data);
    } else {
      relationship = new Relationship(this.client, data);
      this.client.relationships.insert(relationship);
    }

    this.client.emit(ClientEvents.RELATIONSHIP_ADD, {
      differences,
      relationship,
    });
  }

  [GatewayDispatchEvents.RELATIONSHIP_REMOVE](data: Types.RelationshipRemove) {
    let relationship: Relationship;

    if (this.client.relationships.has(data['id'])) {
      relationship = <Relationship> this.client.relationships.get(data['id']);
      this.client.relationships.delete(data['id']);
    } else {
      relationship = new Relationship(this.client, data);
    }

    this.client.emit(ClientEvents.RELATIONSHIP_REMOVE, {
      id: data['id'],
      relationship,
      type: data['type'],
    });
  }

  [GatewayDispatchEvents.SESSIONS_UPDATE](data: Types.SessionsUpdate) {

  }

  [GatewayDispatchEvents.STREAM_CREATE](data: Types.StreamCreate) {
    this.client.emit(ClientEvents.STREAM_CREATE, {
      paused: data['paused'],
      region: data['region'],
      rtcServerId: data['rtc_server_id'],
      streamKey: data['stream_key'],
      viewerIds: data['viewer_ids'],
    });
  }

  [GatewayDispatchEvents.STREAM_DELETE](data: Types.StreamDelete) {
    this.client.emit(ClientEvents.STREAM_DELETE, {
      reason: data['reason'],
      streamKey: data['stream_key'],
      unavailable: data['unavailable'],
    });
  }

  [GatewayDispatchEvents.STREAM_SERVER_UPDATE](data: Types.StreamServerUpdate) {
    this.client.emit(ClientEvents.STREAM_SERVER_UPDATE, {
      endpoint: data['endpoint'],
      streamKey: data['stream_key'],
      token: data['token'],
    });
  }

  [GatewayDispatchEvents.STREAM_UPDATE](data: Types.StreamUpdate) {
    this.client.emit(ClientEvents.STREAM_UPDATE, {
      paused: data['paused'],
      region: data['region'],
      streamKey: data['stream_key'],
      viewerIds: data['viewer_ids'],
    });
  }

  [GatewayDispatchEvents.TYPING_START](data: Types.TypingStart) {
    const channelId = data['channel_id'];
    const guildId = data['guild_id'];
    let typing: Typing;
    const userId = data['user_id'];

    if (this.client.typing.has(channelId, userId)) {
      typing = <Typing> this.client.typing.get(channelId, userId);
      typing.merge(data);
    } else {
      typing = new Typing(this.client, data);
      this.client.typing.insert(typing);
    }

    this.client.emit(ClientEvents.TYPING_START, {
      channelId,
      guildId,
      typing,
      userId,
    });
  }

  [GatewayDispatchEvents.USER_ACHIEVEMENT_UPDATE](data: Types.UserAchievementUpdate) {

  }

  [GatewayDispatchEvents.USER_CONNECTIONS_UPDATE](data: Types.UserConnectionsUpdate) {
    // maybe fetch from rest api when this happens to keep cache up to date?
  }

  [GatewayDispatchEvents.USER_FEED_SETTINGS_UPDATE](data: Types.UserFeedSettingsUpdate) {

  }

  [GatewayDispatchEvents.USER_GUILD_SETTINGS_UPDATE](data: Types.UserGuildSettingsUpdate) {

  }

  [GatewayDispatchEvents.USER_NOTE_UPDATE](data: Types.UserNoteUpdate) {
    let user: null | User = null;
    if (this.client.users.has(data.id)) {
      user = <User> this.client.users.get(data.id);
    }
    this.client.notes.insert(data.id, data.note);

    this.client.emit(ClientEvents.USER_NOTE_UPDATE, {
      note: data.note,
      user,
      userId: data.id,
    });
  }

  [GatewayDispatchEvents.USER_PAYMENT_SOURCES_UPDATE](data: Types.UserPaymentSourcesUpdate) {
    // maybe fetch from rest api when this happens to keep cache up to date?
  }

  [GatewayDispatchEvents.USER_PAYMENTS_UPDATE](data: Types.UserPaymentsUpdate) {
    // maybe fetch from rest api when this happens to keep cache up to date?
  }

  [GatewayDispatchEvents.USER_REQUIRED_ACTION_UPDATE](data: Types.UserRequiredActionUpdate) {

  }

  [GatewayDispatchEvents.USER_SETTINGS_UPDATE](data: Types.UserSettingsUpdate) {
    
  }

  [GatewayDispatchEvents.USER_UPDATE](data: Types.UserUpdate) {
    // this updates this.client.user, us
    let differences: any = null;
    let user: UserMe;

    if (this.client.user) {
      user = this.client.user;
      if (this.client.hasEventListener(ClientEvents.USER_UPDATE)) {
        differences = user.differences(data);
      }
      user.merge(data);
    } else {
      user = new UserMe(this.client, data);
      this.client.user = user;
      this.client.users.insert(user);
    }
    this.client.emit(ClientEvents.USER_UPDATE, {differences, user});
  }

  [GatewayDispatchEvents.VOICE_SERVER_UPDATE](data: Types.VoiceServerUpdate) {
    this.client.emit(ClientEvents.VOICE_SERVER_UPDATE, {
      channelId: data['channel_id'],
      endpoint: data['endpoint'],
      guildId: data['guild_id'],
      token: data['token'],
    });
  }

  [GatewayDispatchEvents.VOICE_STATE_UPDATE](data: Types.VoiceStateUpdate) {
    let differences: any = null;
    let leftChannel = false;
    let voiceState: VoiceState;

    const serverId = data['guild_id'] || data['channel_id'];
    if (this.client.voiceStates.has(serverId, data['user_id'])) {
      voiceState = <VoiceState> this.client.voiceStates.get(serverId, data['user_id']);
      if (this.client.hasEventListener(ClientEvents.VOICE_STATE_UPDATE)) {
        differences = voiceState.differences(data);
      }
      voiceState.merge(data);
      if (!data['channel_id']) {
        this.client.voiceStates.delete(serverId, data['user_id']);
        leftChannel = true;
      }
    } else {
      voiceState = new VoiceState(this.client, data);
      this.client.voiceStates.insert(voiceState);
    }
    this.client.emit(ClientEvents.VOICE_STATE_UPDATE, {
      differences,
      leftChannel,
      voiceState,
    });
  }

  [GatewayDispatchEvents.WEBHOOKS_UPDATE](data: Types.WebhooksUpdate) {
    this.client.emit(ClientEvents.WEBHOOKS_UPDATE, {
      channelId: data['channel_id'],
      guildId: data['guild_id'],
    });
  }
}