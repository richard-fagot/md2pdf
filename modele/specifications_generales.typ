#import "obsidian.typ": callout, setTemplate, subtitle, project, horizontalrule

#let specifications_generales(projet, sujet, titre, sous_titre, version, statut, date, doc) = {
  
  show: setTemplate(projet, titre, sous_titre, version, statut, date)
  
  /*** Document ***/
  set page(numbering: none) 
  
  project(projet)
  title(titre)
  subtitle(sous_titre)
  pagebreak(weak: true)
  outline(indent: 1em)
  pagebreak(weak: true)
  outline(
    title: [Table des figures],
    target: figure.where(kind: image),
  )
  pagebreak(weak: true)
  set page(numbering: "1/1")
  counter(page).update(1) 
  
  doc
}