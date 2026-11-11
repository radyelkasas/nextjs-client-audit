"use client";

import { useForm } from "react-hook-form";
import { SettingsIntro } from "@/components/SettingsIntro";

type Values = { displayName: string };

export default function SettingsPage() {
  const { register, handleSubmit } = useForm<Values>();
  return (
    <section>
      <SettingsIntro />
      <form onSubmit={handleSubmit((v) => console.log(v))}>
        <input {...register("displayName")} />
        <button type="submit">Save</button>
      </form>
    </section>
  );
}
