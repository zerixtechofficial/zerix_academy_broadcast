import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { env } from './env';

export const livekitRoomService = new RoomServiceClient(
  env.LIVEKIT_URL,
  env.LIVEKIT_API_KEY,
  env.LIVEKIT_API_SECRET
);

export interface LiveKitTokenParams {
  roomName: string;
  participantIdentity: string;
  participantName: string;
  canPublishAudio: boolean;
  canSubscribe?: boolean;
}

export async function generateLiveKitToken(params: LiveKitTokenParams): Promise<string> {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: params.participantIdentity,
    name: params.participantName,
    ttl: '24h',
  });

  at.addGrant({
    roomJoin: true,
    room: params.roomName,
    canPublish: params.canPublishAudio,
    canPublishData: true,
    canSubscribe: params.canSubscribe !== undefined ? params.canSubscribe : true,
  });

  return await at.toJwt();
}
