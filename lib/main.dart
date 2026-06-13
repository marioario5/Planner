import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'planner_screen.dart';

void main() {
  runApp(const CozyPlannerApp());
}

class CozyPlannerApp extends StatelessWidget {
  const CozyPlannerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "Today's Tasks",
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        textTheme: GoogleFonts.pressStart2pTextTheme(),
      ),
      home: const PlannerScreen(),
    );
  }
}
