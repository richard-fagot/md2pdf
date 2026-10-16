#import "obsidian.typ": callout, setTemplate, subtitle, project, horizontalrule

#let compte_rendu(projet, titre, sous_titre, version, statut, date, doc) = {
  
  show: setTemplate(projet, titre, sous_titre, version, statut, date)
  
  /*** Document ***/
  set page(numbering: none) 
  
  project(projet)
  title(titre)
  subtitle(sous_titre)
  
  set page(numbering: "1/1")
  counter(page).update(1) 
  
  doc
}