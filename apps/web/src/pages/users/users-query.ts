import {
  type ResetPasswordRequest,
  type UpdateUserRequest,
  userListResponseSchema,
  userSchema,
} from '@camex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const usersQueryKey = ['users'] as const;

export function useUsers() {
  return useQuery({
    queryKey: usersQueryKey,
    queryFn: async () => (await api('/users', userListResponseSchema)).users,
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateUserRequest & { id: string }) =>
      api(`/users/${id}`, userSchema, { method: 'PATCH', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: usersQueryKey }),
  });
}

export function useResetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ResetPasswordRequest & { id: string }) =>
      api(`/users/${id}/reset-password`, userSchema, { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: usersQueryKey }),
  });
}
