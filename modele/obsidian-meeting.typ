#import "@preview/cheq:0.3.0": checklist


#let obsidian(filename, type, date, doc) = {
  
  /***********************************/
  /* Définition des niveaux de gris  */
  /* pour faciliter la lecture sur   */
  /* écran (valeurs empiriques selon */
  /* Claude.ai).                     */
  /***********************************/
  let mainTextColor = luma(10%)//luma(15%)
  let secondartyTextColor = luma(0%)//luma(35%)
  let terTextColor = luma(0%)//luma(50%)
  
  /***********************************/
  /*    Configuration de la page.    */
  /***********************************/
  set page(
    paper: "a4",
    margin: (left: 2.5cm, right: 2.5cm, top: 3.5cm, bottom: 2.5cm),
    header-ascent: 1cm,
    header: [
      #set align(left)
      #block(width: 100%)[#image("logo.webp", height: 2cm)]
    ],
    numbering: "1/1",
    binding: right
  )

  /***********************************/
  /*. Propriétés générales du texte. */
  /***********************************/
  set text(
    lang: "fr",
    //font: "New Computer Modern",
    font: "Arial",
    size: 11pt,
    fill: mainTextColor
  )
  
  
  /***********************************/
  /*  Configuration des paragraphes. */
  /***********************************/
  set par(
    // Indentation de chaque paragraphe
    // source : https://typst.app/docs/reference/model/par/#parameters-first-line-indent
    first-line-indent:(amount: 2em, all: true),
    spacing: 1.5em,
    justify: true,
  )

  /***********************************/
  /*   Configuration des sections.   */
  /***********************************/
  set heading(numbering: "1.")
  show heading: it => {
    
    let contenu = smallcaps[#it]
    v(1em)//, weak: true)
    
    if it.level >= 4 {
      emph(contenu)
    } 
    else { contenu }
      
    v(-0.5em)
    line(length: 100%, stroke: 0.5pt)
    v(0.5em)//, weak: true) 
  }

  
  /***********************************/
  /*    Configuration des listes.    */
  /***********************************/
  set list(indent: 1em)
  set list (spacing: 1cm)
  show list: it => {
    //v(1.5em, weak: true)
    it
  }

  /***********************************/
  /*     Configuration du titre.     */
  /***********************************/
  show title: set align(center)
  show title: smallcaps
  show title: set text(size: 20pt, fill: mainTextColor)
  
  /***********************************/
  /*   Configuration du sous-titre.  */
  /***********************************/
  let subtitle(body) = {
    v(0.5cm, weak: true)
    set align(center)
    set text(size: 16pt, weight: "semibold", fill: secondartyTextColor)
    
    smallcaps[#body]
  }
  
  /***********************************/
  /*   Configuration de la date.     */
  /***********************************/
  let dateMeeting(it) = {
    v(0.5cm, weak: true)
    align(center)[
      #text(fill: secondartyTextColor)[#it]
    ]
    
  }

  show table: set table(stroke: 0.2pt)

  show: checklist
  
  /*** Document ***/
  title(filename)
  subtitle("Spécifications générales")
  grid(
    columns: (1fr, 1fr),
    align(center)[Richard Fagot],
    align(center)[02/12/2025]
  )
  
  doc
}
  
