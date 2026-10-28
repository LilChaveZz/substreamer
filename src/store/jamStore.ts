import { create } from 'zustand';

import type { JamMember, JamRoomSnapshot } from '../services/jam/jamProtocol';

export type JamStatus = 'disconnected' | 'connecting' | 'active' | 'reconnecting' | 'error';

export interface JamState {
  status: JamStatus;
  roomId: string | null;
  memberId: string | null;
  members: JamMember[];
  snapshot: JamRoomSnapshot | null;
  rttMs: number;
  clockOffsetMs: number;
  error: string | null;
  setState: (state: Partial<Omit<JamState, 'setState' | 'reset'>>) => void;
  reset: () => void;
}

const initialState = {
  status: 'disconnected' as JamStatus,
  roomId: null,
  memberId: null,
  members: [],
  snapshot: null,
  rttMs: 0,
  clockOffsetMs: 0,
  error: null,
};

export const jamStore = create<JamState>()((set) => ({
  ...initialState,
  setState: (state) => set(state),
  reset: () => set(initialState),
}));
