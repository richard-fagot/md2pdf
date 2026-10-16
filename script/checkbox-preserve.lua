-- checkbox-preserve.lua
function Str(elem)
  -- ☐ = \9744 (checkbox vide)
  -- ☒ = \9746 (checkbox cochée)
  if elem.text == "☐" then
    return pandoc.RawInline("typst", "[ ]")
  elseif elem.text == "☒" then
    return pandoc.RawInline("typst", "[x]")
  end
  return elem
end