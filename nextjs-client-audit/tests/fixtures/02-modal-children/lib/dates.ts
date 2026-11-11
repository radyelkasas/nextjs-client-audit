import { formatDistanceToNow } from "date-fns";

export const timeAgo = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });
