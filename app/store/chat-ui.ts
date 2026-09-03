/**
 * ZUSTAND — LOCAL UI state ONLY.
 *
 * There is NO order state here (status, quote, the amount created...). Order
 * state lives on the server and is held by TanStack Query; duplicating it into
 * the store would create two sources of truth.
 *
 * `accessToken` lives here because it is the *browser session key*, not order
 * state. It is persisted so reloading the page does not lose an in-flight
 * transaction — with skipHydration to avoid a server/client render mismatch.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface RecipientDraft {
  fullName: string
  bankName: string
  accountNumber: string
  bankCode: string
}

export const emptyRecipientDraft: RecipientDraft = {
  fullName: '',
  bankName: '',
  accountNumber: '',
  bankCode: '',
}

interface ChatUiState {
  /** Browser session key. Not order state. */
  accessToken: string | null
  /** Draft of the message being typed. */
  amountDraft: string
  recipientDraft: RecipientDraft

  setAccessToken: (token: string | null) => void
  setAmountDraft: (v: string) => void
  setRecipientDraft: (patch: Partial<RecipientDraft>) => void
  /** Start a new transaction — clears local state only, never touches the server. */
  resetSession: () => void
}

export const useChatUi = create<ChatUiState>()(
  persist(
    (set) => ({
      accessToken: null,
      amountDraft: '',
      recipientDraft: emptyRecipientDraft,

      setAccessToken: (accessToken) => set({ accessToken }),
      setAmountDraft: (amountDraft) => set({ amountDraft }),
      setRecipientDraft: (patch) =>
        set((s) => ({ recipientDraft: { ...s.recipientDraft, ...patch } })),
      resetSession: () =>
        set({ accessToken: null, amountDraft: '', recipientDraft: emptyRecipientDraft }),
    }),
    {
      name: 'transpay-chat-session',
      // Persist the session key only; half-typed drafts need not survive a reload.
      partialize: (s) => ({ accessToken: s.accessToken }),
      skipHydration: true,
    },
  ),
)
