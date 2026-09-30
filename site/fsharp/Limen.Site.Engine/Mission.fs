namespace Limen.Site.Engine

/// Stable integration fixtures mirrored from Forma's NASA example domain.
///
/// This module exists to prove a consuming F# application can own the state
/// behind Forma presentation while Limen remains the browser boundary. It is
/// not a Limen protocol type and it is not application state owned by Forma.
module Mission =

    type Mission =
        { Id: string
          Name: string
          Program: string
          MissionType: string
          LaunchDate: string
          ReturnDate: string
          Crewed: bool
          Crew: string list
          Spacecraft: string
          LaunchVehicle: string
          Destination: string
          Status: string
          Highlight: string
          SourceUrl: string }

    let all =
        [ { Id = "gemini-iv"
            Name = "Gemini IV"
            Program = "Gemini"
            MissionType = "Human Spaceflight"
            LaunchDate = "1965-06-03"
            ReturnDate = "1965-06-07"
            Crewed = true
            Crew = [ "James A. McDivitt Jr."; "Edward H. White II" ]
            Spacecraft = "Gemini 4"
            LaunchVehicle = "Titan II"
            Destination = "Low Earth orbit"
            Status = "Complete"
            Highlight = "First American spacewalk"
            SourceUrl = "https://www.nasa.gov/mission/gemini-iv/" }
          { Id = "apollo-8"
            Name = "Apollo 8"
            Program = "Apollo"
            MissionType = "Lunar Landing Preparation"
            LaunchDate = "1968-12-21"
            ReturnDate = "1968-12-27"
            Crewed = true
            Crew = [ "Frank Borman"; "James A. Lovell Jr."; "William A. Anders" ]
            Spacecraft = "Apollo command and service module"
            LaunchVehicle = "Saturn V"
            Destination = "Lunar orbit"
            Status = "Complete"
            Highlight = "First crewed mission to orbit the Moon"
            SourceUrl = "https://www.nasa.gov/mission/apollo-8/" }
          { Id = "apollo-11"
            Name = "Apollo 11"
            Program = "Apollo"
            MissionType = "Lunar Landing"
            LaunchDate = "1969-07-16"
            ReturnDate = "1969-07-24"
            Crewed = true
            Crew = [ "Neil Armstrong"; "Edwin E. \"Buzz\" Aldrin Jr."; "Michael Collins" ]
            Spacecraft = "Columbia and Eagle"
            LaunchVehicle = "Saturn V"
            Destination = "Sea of Tranquility, Moon"
            Status = "Complete"
            Highlight = "First crewed lunar landing"
            SourceUrl = "https://www.nasa.gov/mission/apollo-11/" }
          { Id = "apollo-13"
            Name = "Apollo 13"
            Program = "Apollo"
            MissionType = "Lunar Landing"
            LaunchDate = "1970-04-11"
            ReturnDate = "1970-04-17"
            Crewed = true
            Crew = [ "James A. Lovell Jr."; "Fred W. Haise Jr."; "John L. Swigert Jr." ]
            Spacecraft = "Odyssey and Aquarius"
            LaunchVehicle = "Saturn V"
            Destination = "Lunar free-return trajectory"
            Status = "Complete"
            Highlight = "Crew safely returned after an in-flight oxygen tank failure"
            SourceUrl = "https://www.nasa.gov/mission/apollo-13/" }
          { Id = "sts-1"
            Name = "STS-1"
            Program = "Space Shuttle"
            MissionType = "Orbital flight test"
            LaunchDate = "1981-04-12"
            ReturnDate = "1981-04-14"
            Crewed = true
            Crew = [ "John W. Young"; "Robert L. Crippen" ]
            Spacecraft = "Columbia"
            LaunchVehicle = "Space Shuttle"
            Destination = "Low Earth orbit"
            Status = "Complete"
            Highlight = "First flight of NASA's Space Shuttle program"
            SourceUrl = "https://www.nasa.gov/mission/sts-1/" }
          { Id = "sts-31"
            Name = "STS-31"
            Program = "Space Shuttle"
            MissionType = "Satellite deployment mission"
            LaunchDate = "1990-04-24"
            ReturnDate = "1990-04-29"
            Crewed = true
            Crew = [ "Loren J. Shriver"; "Charles F. Bolden"; "Bruce McCandless II"; "Kathryn D. Sullivan"; "Steven A. Hawley" ]
            Spacecraft = "Discovery"
            LaunchVehicle = "Space Shuttle"
            Destination = "Low Earth orbit"
            Status = "Complete"
            Highlight = "Deployed the Hubble Space Telescope"
            SourceUrl = "https://www.nasa.gov/mission/sts-31/" }
          { Id = "sts-95"
            Name = "STS-95"
            Program = "Space Shuttle"
            MissionType = "Research mission"
            LaunchDate = "1998-10-29"
            ReturnDate = "1998-11-07"
            Crewed = true
            Crew = [ "Curtis L. Brown"; "Steven W. Lindsey"; "Scott E. Parazynski"; "Stephen K. Robinson"; "Pedro Duque"; "Chiaki Mukai"; "John H. Glenn" ]
            Spacecraft = "Discovery"
            LaunchVehicle = "Space Shuttle"
            Destination = "Low Earth orbit"
            Status = "Complete"
            Highlight = "Returned John Glenn to space and carried research payloads"
            SourceUrl = "https://www.nasa.gov/mission/sts-95/" }
          { Id = "artemis-i"
            Name = "Artemis I"
            Program = "Artemis"
            MissionType = "Uncrewed lunar flight test"
            LaunchDate = "2022-11-16"
            ReturnDate = "2022-12-11"
            Crewed = false
            Crew = []
            Spacecraft = "Orion"
            LaunchVehicle = "Space Launch System"
            Destination = "Lunar distant retrograde orbit"
            Status = "Complete"
            Highlight = "First integrated flight test of SLS and Orion"
            SourceUrl = "https://www.nasa.gov/mission/artemis-i/" } ]

    let tryFind id =
        all |> List.tryFind (fun mission -> mission.Id = id)

    let find id =
        match tryFind id with
        | Some mission -> mission
        | None -> invalidArg "id" $"Unknown Forma NASA reference mission '{id}'."
