export type Item = {
  id: number;
  name: string;
  location: string;
  date: string;
  description: string;
  image: string | null;
  created_at: string;

  user_id?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  user_profile_image?: string | null;
};