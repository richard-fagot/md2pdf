--[[
  callouts.lua – Filtre Pandoc pour convertir les callouts Obsidian en blocs Typst.
  Préserve le formatage (gras, italique, code, vraies listes Markdown).
  Reconstruit aussi les pseudo-listes inline (lignes commençant par "- ").

  Format Obsidian :
    > [!TYPE]          (casse libre : Note, NOTE, note…)
    > Corps
  ou
    > [!TYPE] Titre personnalisé
    > Corps

  Types reconnus et normalisés vers 5 catégories visuelles :
    note / tip / important / warning / caution
--]]

-- Normalise le type Obsidian (casse libre) vers l'un des 5 types Typst
local function normalizeType(raw)
  local upper = raw:upper()
  local map = {
    NOTE="note", INFO="note", EXAMPLE="note", QUOTE="note",
    ABSTRACT="note", SUMMARY="note", TLDR="note",
    TIP="tip", HINT="tip", SUCCESS="tip", CHECK="check", DONE="tip",
    IMPORTANT="important", QUESTION="question", HELP="important",
    FAQ="important", TODO="important",
    WARNING="warning",
    CAUTION="caution", DANGER="caution", BUG="caution",
    FAILURE="caution", FAIL="caution", MISSING="caution", ERROR="caution",
  }
  return map[upper] or "note"
end

-- Échappe backslashes et guillemets doubles pour un littéral string Typst
local function escTypst(s)
  return s:gsub('\\', '\\\\'):gsub('"', '\\"')
end

-- Extrait le texte brut d'une liste d'inlines (pour le titre)
local function inlinesToText(inlines)
  local parts = {}
  for _, el in ipairs(inlines) do
    if     el.t == "Str"   then table.insert(parts, el.text)
    elseif el.t == "Space" or el.t == "SoftBreak" then table.insert(parts, " ")
    elseif el.t == "Emph" or el.t == "Strong" or el.t == "Strikeout" then
      table.insert(parts, inlinesToText(el.content))
    elseif el.t == "Code"  then table.insert(parts, el.text)
    end
  end
  return table.concat(parts, "")
end

--[[
  Reconstruit une BulletList à partir d'inlines où les items sont séparés
  par SoftBreak et commencent par "- " ou "* ".
  Retourne une liste de pandoc.Block ou nil si la structure ne ressemble pas
  à une liste.
--]]
local function tryRebuildList(inlines)
  -- Découper sur les SoftBreak
  local lines = {}
  local current = {}
  for _, inl in ipairs(inlines) do
    if inl.t == "SoftBreak" or inl.t == "LineBreak" then
      table.insert(lines, current)
      current = {}
    else
      table.insert(current, inl)
    end
  end
  if #current > 0 then table.insert(lines, current) end

  -- Vérifier que TOUTES les lignes commencent par un marqueur de liste
  local markers = { "^%- $", "^%* $", "^%–$", "^%-$", "^%*$" }
  local function startsWithMarker(line)
    if #line == 0 then return false end
    local first = line[1]
    if first.t ~= "Str" then return false end
    for _, pat in ipairs(markers) do
      if first.text:match(pat) then return true end
    end
    -- Marqueur collé : "-Text" → non, on veut "- " suivi d'autre chose
    return false
  end

  -- Un item de liste = première Str est "-" ou "*" ou "–", suivie d'un Space
  local function extractItem(line)
    if #line < 2 then return nil end
    local first = line[1]
    if first.t ~= "Str" then return nil end
    if first.text ~= "-" and first.text ~= "*" and first.text ~= "–" then return nil end
    local second = line[2]
    if second.t ~= "Space" then return nil end
    -- Le reste de la ligne est le contenu
    local rest = {}
    for i = 3, #line do table.insert(rest, line[i]) end
    return rest
  end

  local items = {}
  for _, line in ipairs(lines) do
    local item = extractItem(line)
    if item then
      table.insert(items, { pandoc.Plain(item) })
    else
      -- Ligne non-liste → ce n'est pas une liste pure, abandonner
      return nil
    end
  end

  if #items == 0 then return nil end
  return { pandoc.BulletList(items) }
end

function BlockQuote(el)
  if #el.content == 0 then return nil end

  local firstBlock = el.content[1]
  if firstBlock.t ~= "Para" and firstBlock.t ~= "Plain" then return nil end
  if #firstBlock.content == 0 then return nil end

  -- Premier inline : doit matcher [!TYPE] ou [!TYPE]TitreCollé
  -- Casse libre grâce à [%a]+ au lieu de [A-Z]+
  local firstInline = firstBlock.content[1]
  if firstInline.t ~= "Str" then return nil end

  local typeStr, trailing = firstInline.text:match("^%[!([%a]+)%](.*)")
  if not typeStr then return nil end

  local normalizedType = normalizeType(typeStr)

  -- ── Titre ─────────────────────────────────────────────────────────────
  local titleParts = {}
  if trailing and trailing ~= "" then
    table.insert(titleParts, trailing)
  end
  for i = 2, #firstBlock.content do
    local inl = firstBlock.content[i]
    if inl.t == "SoftBreak" or inl.t == "LineBreak" then break end
    if     inl.t == "Space" then table.insert(titleParts, " ")
    elseif inl.t == "Str"   then table.insert(titleParts, inl.text)
    else table.insert(titleParts, inlinesToText({inl}))
    end
  end
  local customTitle = nil
  local ts = table.concat(titleParts):match("^%s*(.-)%s*$")
  if ts and ts ~= "" then customTitle = ts end

  -- ── Corps ─────────────────────────────────────────────────────────────
  -- Inlines après le premier SoftBreak dans le premier Para
  local bodyBlocks = {}
  local afterBreak = false
  local remainingInlines = {}

  for i = 2, #firstBlock.content do
    local inl = firstBlock.content[i]
    if not afterBreak then
      if inl.t == "SoftBreak" or inl.t == "LineBreak" then afterBreak = true end
    else
      table.insert(remainingInlines, inl)
    end
  end

  if #remainingInlines > 0 then
    -- Tenter de reconstruire une BulletList si les lignes ressemblent à une liste
    local rebuilt = tryRebuildList(remainingInlines)
    if rebuilt then
      for _, b in ipairs(rebuilt) do table.insert(bodyBlocks, b) end
    else
      table.insert(bodyBlocks, pandoc.Para(remainingInlines))
    end
  end

  -- Blocs supplémentaires du blockquote (vrais BulletList, CodeBlock, etc.)
  for i = 2, #el.content do
    table.insert(bodyBlocks, el.content[i])
  end

  -- ── Sérialiser en Typst ───────────────────────────────────────────────
  local bodyTypst = ""
  if #bodyBlocks > 0 then
    bodyTypst = pandoc.write(pandoc.Pandoc(bodyBlocks), "typst")
    bodyTypst = bodyTypst:match("^%s*(.-)%s*$")
  end

  local titleArg = customTitle and ('"' .. escTypst(customTitle) .. '"') or "none"
  -- Passer `none` si le corps est vide pour que Typst puisse le détecter fiablement
  local bodyArg
  if bodyTypst == "" then
    bodyArg = "none"
  else
    bodyArg = string.format("[\n%s\n]", bodyTypst)
  end
  local typstCode = string.format(
    '#callout("%s", %s, %s)',
    normalizedType, titleArg, bodyArg
  )
  return pandoc.RawBlock("typst", typstCode)
end
