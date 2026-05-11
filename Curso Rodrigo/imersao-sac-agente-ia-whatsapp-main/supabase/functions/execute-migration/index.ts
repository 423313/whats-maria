import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Cria cliente Supabase dentro da função
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2"
    );

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ error: "Missing environment variables" }),
        { status: 500, headers: corsHeaders }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Executa migração: adiciona coluna skip_followup
    const sql = `
      ALTER TABLE public.chat_control
      ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;
    `;

    // Nota: Supabase não permite executar SQL via Edge Function diretamente
    // Mas podemos usar uma RPC que já existe ou criar um trigger
    // Por enquanto, retornamos instruções

    return new Response(
      JSON.stringify({
        status: "success",
        message:
          "Migração precisa ser executada manualmente no SQL Editor do Supabase",
        sql: sql,
        link: "https://supabase.com/dashboard/project/jnfeerxcxxmgjutkfzig/sql/new",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
